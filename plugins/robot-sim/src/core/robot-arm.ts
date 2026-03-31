// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import gsap from "gsap";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
    type AnimationState,
    GRIPPER_AXIS_MAP,
    JOINT_AXIS_MAP,
    type JointConfig,
    type JSONActionSequence,
    type JSONKeyFrame,
} from "./joint-config";
import { type TrajectoryPoint, TrajectoryVisualizer } from "./trajectory-visualizer";

export class RobotArm {
    private model: THREE.Group | null = null;
    private joints: Map<string, THREE.Object3D> = new Map();
    private jointConfigs: JointConfig[] = [];
    private jointNames: string[] = Object.keys(JOINT_AXIS_MAP);
    private grippers: Map<string, THREE.Object3D> = new Map();
    private gripperConfigs: JointConfig[] = [];
    private gripperNames: string[] = Object.keys(GRIPPER_AXIS_MAP);
    private allComponentsConfigs: JointConfig[] = [];
    private loader: GLTFLoader;
    private animationState: AnimationState = {
        isPlaying: false,
        isPaused: false,
        currentProgress: 0,
        currentKeyFrameIndex: 0,
        timeline: null,
        currentSequence: null,
    };
    private gripperAnimationTimeline: gsap.core.Timeline | null = null;
    private gripperOpenness: number = 0;
    private constantAngularVelocity: number = 360 / 4.8;
    private trajectoryVisualizer: TrajectoryVisualizer | null = null;
    private trajectoryRecordingInterval: number | null = null;
    private currentTrajectoryFrameId: number = 0;
    private modelContainer: THREE.Group | null = null;
    private directionalLight: THREE.DirectionalLight | null = null;

    constructor(private scene: THREE.Scene) {
        this.loader = new GLTFLoader();
        this.trajectoryVisualizer = new TrajectoryVisualizer(scene);
    }

    async loadModelFromUrl(url: string): Promise<void> {
        const gltf = await this.loader.loadAsync(url);
        this.model = gltf.scene;

        // Wrap model in a container to handle Y-up to Z-up conversion.
        // Chili3D uses Z-up (Object3D.DEFAULT_UP = 0,0,1), robot models are Y-up.
        this.modelContainer = new THREE.Group();
        this.modelContainer.rotation.x = Math.PI / 2;

        // Scale up: Chili3D scene works at ~100-250 unit scale, robot model is ~1 unit
        const scaleFactor = 100;
        this.modelContainer.scale.setScalar(scaleFactor);

        this.modelContainer.add(this.model);
        this.scene.add(this.modelContainer);

        // Add directional light for better model visibility
        this.directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        this.directionalLight.position.set(200, 200, 300);
        this.scene.add(this.directionalLight);

        this.initializeJoints();
    }

    async loadModelFromFile(file: File): Promise<void> {
        const url = URL.createObjectURL(file);
        try {
            await this.loadModelFromUrl(url);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    private initializeJoints(): void {
        if (!this.model) return;

        this.joints.clear();
        this.grippers.clear();
        this.jointConfigs = [];
        this.gripperConfigs = [];

        this.model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.receiveShadow = false;
                child.castShadow = true;
            }

            if (this.jointNames.includes(child.name)) {
                const helper = new THREE.AxesHelper(0.1);
                helper.visible = false;
                child.add(helper);
                this.joints.set(child.name, child);

                const axis = JOINT_AXIS_MAP[child.name];
                const currentAngle = THREE.MathUtils.radToDeg(
                    child.rotation[axis.toLowerCase() as keyof THREE.Euler] as number,
                );

                this.jointConfigs.push({
                    name: child.name,
                    axis,
                    minAngle: -360,
                    maxAngle: 360,
                    defaultAngle: currentAngle,
                    currentAngle,
                });
            }

            if (this.gripperNames.includes(child.name)) {
                const helper = new THREE.AxesHelper(0.1);
                helper.visible = false;
                child.add(helper);
                this.grippers.set(child.name, child);

                const axis = GRIPPER_AXIS_MAP[child.name];
                const currentAngle = THREE.MathUtils.radToDeg(
                    child.rotation[axis.toLowerCase() as keyof THREE.Euler] as number,
                );

                this.gripperConfigs.push({
                    name: child.name,
                    axis,
                    minAngle: child.name === "gripper1" ? -23 : -30,
                    maxAngle: child.name === "gripper1" ? 30 : 23,
                    defaultAngle: currentAngle,
                    currentAngle,
                });
            }
        });

        this.allComponentsConfigs = [...this.jointConfigs, ...this.gripperConfigs];
    }

    setJointAngle(jointName: string, angle: number): void {
        const joint = this.joints.get(jointName);
        const config = this.jointConfigs.find((c) => c.name === jointName);
        if (!joint || !config) return;

        const clampedAngle = Math.max(config.minAngle, Math.min(config.maxAngle, angle));
        config.currentAngle = clampedAngle;

        const rad = THREE.MathUtils.degToRad(clampedAngle);
        switch (config.axis) {
            case "X":
                joint.rotation.x = rad;
                break;
            case "Y":
                joint.rotation.y = rad;
                break;
            case "Z":
                joint.rotation.z = rad;
                break;
        }
    }

    animateJointAngle(
        jointName: string,
        targetAngle: number,
        duration: number = 0.5,
        callback?: {
            onStart?: () => void;
            onUpdate?: () => void;
            onComplete?: () => void;
        },
    ): void {
        const joint = this.joints.get(jointName);
        const config = this.jointConfigs.find((c) => c.name === jointName);
        if (!joint || !config) return;

        const clampedAngle = Math.max(config.minAngle, Math.min(config.maxAngle, targetAngle));
        if (Math.abs(config.currentAngle - clampedAngle) < 0.01) return;

        if (this.animationState.timeline) {
            this.animationState.timeline.kill();
            this.animationState.timeline = null;
        }
        this.animationState.timeline = gsap.timeline();

        this.animationState.timeline.to(config, {
            currentAngle: clampedAngle,
            duration,
            ease: "none",
            onUpdate: () => {
                this.setJointAngle(jointName, config.currentAngle);
                callback?.onUpdate?.();
            },
            onComplete: () => callback?.onComplete?.(),
            onStart: () => callback?.onStart?.(),
        });
    }

    animateMultipleJoints(
        jointAngles: Record<string, number>,
        duration: number = 0.5,
        callback?: {
            onStart?: () => void;
            onUpdate?: () => void;
            onComplete?: () => void;
        },
    ): void {
        if (this.animationState.timeline) {
            this.animationState.timeline.kill();
            this.animationState.timeline = null;
        }
        this.animationState.timeline = gsap.timeline({
            onStart: () => callback?.onStart?.(),
            onComplete: () => callback?.onComplete?.(),
            onUpdate: () => callback?.onUpdate?.(),
        });

        Object.entries(jointAngles).forEach(([jointName, targetAngle]) => {
            const jointConfig = this.jointConfigs.find((c) => c.name === jointName);
            if (jointConfig) {
                this.animationState.timeline!.to(
                    jointConfig,
                    {
                        currentAngle: targetAngle,
                        duration,
                        ease: "none",
                        onUpdate: () => {
                            this.setJointAngle(jointName, jointConfig.currentAngle);
                        },
                    },
                    0,
                );
            }
        });
    }

    setGripperAngle(gripperName: string, angle: number): void {
        const gripper = this.grippers.get(gripperName);
        const config = this.gripperConfigs.find((c) => c.name === gripperName);
        if (!gripper || !config) return;

        const clampedAngle = Math.max(config.minAngle, Math.min(config.maxAngle, angle));
        config.currentAngle = clampedAngle;

        const rad = THREE.MathUtils.degToRad(clampedAngle);
        switch (config.axis) {
            case "X":
                gripper.rotation.x = rad;
                break;
            case "Y":
                gripper.rotation.y = rad;
                break;
            case "Z":
                gripper.rotation.z = rad;
                break;
        }
    }

    setGripperOpenness(openness: number): void {
        const clampedOpenness = Math.max(0, Math.min(1, openness));
        const gripper1Config = this.gripperConfigs.find((c) => c.name === "gripper1");
        const gripper2Config = this.gripperConfigs.find((c) => c.name === "gripper2");
        if (!gripper1Config || !gripper2Config) return;

        const gripper1Angle =
            gripper1Config.minAngle + clampedOpenness * (gripper1Config.maxAngle - gripper1Config.minAngle);
        const gripper2Angle =
            gripper2Config.maxAngle + clampedOpenness * (gripper2Config.minAngle - gripper2Config.maxAngle);

        this.setGripperAngle("gripper1", gripper1Angle);
        this.setGripperAngle("gripper2", gripper2Angle);
    }

    animateGripperOpenness(openness: number, duration: number = 0.5): void {
        if (this.gripperAnimationTimeline) {
            this.gripperAnimationTimeline.kill();
        }
        this.gripperAnimationTimeline = gsap.timeline();
        this.gripperAnimationTimeline.to(this, {
            gripperOpenness: openness,
            duration,
            ease: "none",
            onUpdate: () => {
                this.setGripperOpenness(this.gripperOpenness);
            },
        });
    }

    getJointConfigs(): JointConfig[] {
        return [...this.jointConfigs];
    }

    getGripperConfigs(): JointConfig[] {
        return [...this.gripperConfigs];
    }

    getModel(): THREE.Group | null {
        return this.model;
    }

    toggleAxisHelper(visible?: boolean): void {
        const toggle = (obj: THREE.Object3D) => {
            const helper = obj.children.find((child) => child instanceof THREE.AxesHelper);
            if (helper) {
                helper.visible = visible !== undefined ? visible : !helper.visible;
            }
        };
        this.joints.forEach(toggle);
        this.grippers.forEach(toggle);
    }

    reset0(options?: { onUpdate?: (config: JointConfig) => void; onComplete?: () => void }): void {
        this.stopAllJointAnimations();
        this.allComponentsConfigs.forEach((config) => {
            gsap.killTweensOf(config, "currentAngle");
            const duration = Math.abs(config.currentAngle - 0) / this.constantAngularVelocity;
            gsap.to(config, {
                currentAngle: 0,
                duration,
                ease: "none",
                onUpdate: () => {
                    config.name.includes("gripper")
                        ? this.setGripperAngle(config.name, config.currentAngle)
                        : this.setJointAngle(config.name, config.currentAngle);
                    options?.onUpdate?.(config);
                },
                onComplete: () => options?.onComplete?.(),
            });
        });
    }

    resetToDefault(options?: { onUpdate?: (config: JointConfig) => void; onComplete?: () => void }): void {
        this.stopAllJointAnimations();
        this.allComponentsConfigs.forEach((config) => {
            gsap.killTweensOf(config, "currentAngle");
            const duration =
                Math.abs(config.currentAngle - config.defaultAngle) / this.constantAngularVelocity;
            gsap.to(config, {
                currentAngle: config.defaultAngle,
                duration,
                ease: "none",
                onUpdate: () => {
                    config.name.includes("gripper")
                        ? this.setGripperAngle(config.name, config.currentAngle)
                        : this.setJointAngle(config.name, config.currentAngle);
                    options?.onUpdate?.(config);
                },
                onComplete: () => options?.onComplete?.(),
            });
        });
    }

    async loadActionSequence(jsonPath: string): Promise<void> {
        const response = await fetch(jsonPath);
        if (!response.ok) {
            throw new Error(`Failed to load action sequence: ${response.statusText}`);
        }
        const sequence: JSONActionSequence = await response.json();
        this.validateActionSequence(sequence);
        this.animationState.currentSequence = sequence;
    }

    async loadActionSequenceFile(file: File): Promise<void> {
        const fileContent = await file.text();
        const sequence: JSONActionSequence = JSON.parse(fileContent);
        this.validateActionSequence(sequence);
        this.animationState.currentSequence = sequence;
    }

    private validateActionSequence(sequence: JSONActionSequence): void {
        if (!Array.isArray(sequence.frames) || sequence.frames.length === 0) {
            throw new Error("Action sequence must contain at least one frame");
        }
        sequence.frames.forEach((frame, index) => {
            if (!Array.isArray(frame.joints) || frame.joints.length !== this.jointNames.length) {
                throw new Error(`Frame ${index}: joints array must have ${this.jointNames.length} values`);
            }
            if (typeof frame.time !== "number") {
                throw new Error(`Frame ${index}: time must be a number`);
            }
        });
    }

    async playActionSequence(
        jsonPath: string,
        options: {
            onUpdate?: (config: JointConfig) => void;
            onProgressUpdate?: (progress: number) => void;
            onStateChange?: (frameId: number, frame: JSONKeyFrame) => void;
            onGripperChange?: (isGripping: boolean) => void;
            onComplete?: () => void;
        } = {},
    ): Promise<void> {
        if (this.animationState.isPlaying && !this.animationState.isPaused) return;

        if (this.animationState.isPaused) {
            this.resumeAnimation();
            return;
        }

        if (!this.animationState.currentSequence) {
            await this.loadActionSequence(jsonPath);
        }

        const sequence = this.animationState.currentSequence!;
        this.stopAnimation();

        const sequenceId = `${sequence.meta.description}_${sequence.meta.created}`;
        this.trajectoryVisualizer?.startNewTrajectory(sequenceId);
        this.currentTrajectoryFrameId = 0;

        this.animationState.timeline = gsap.timeline({
            onUpdate: () => {
                const progress = this.animationState.timeline!.progress();
                this.animationState.currentProgress = progress;
                options.onProgressUpdate?.(progress);
            },
            onComplete: () => {
                this.animationState.isPlaying = false;
                this.animationState.isPaused = false;
                this.animationState.currentProgress = 1;
                options.onProgressUpdate?.(1);
                this.stopTrajectoryRecording();
                this.trajectoryVisualizer?.finishTrajectory();
                options.onComplete?.();
            },
        });

        let timeTick = 0;
        sequence.frames.forEach((frame, index) => {
            const timeInSeconds = frame.time / 1000;
            let frameDuration = 0;

            if (index === 0) {
                frameDuration = Math.min(5, Math.max(timeInSeconds, 1.5));
            } else {
                const prevTimeInSeconds = sequence.frames[index - 1].time / 1000;
                frameDuration = timeInSeconds - prevTimeInSeconds;
            }

            frame.joints.forEach((angleRad, jointIndex) => {
                if (jointIndex < this.jointNames.length) {
                    const jointName = this.jointNames[jointIndex];
                    const config = this.jointConfigs.find((c) => c.name === jointName);
                    if (config) {
                        const targetAngle = THREE.MathUtils.radToDeg(angleRad);
                        this.animationState.timeline!.to(
                            config,
                            {
                                currentAngle: targetAngle,
                                duration: frameDuration,
                                ease: "none",
                                onUpdate: () => {
                                    this.setJointAngle(config.name, config.currentAngle);
                                    options.onUpdate?.(config);
                                },
                            },
                            timeTick,
                        );
                    }
                }
            });

            if (frame.io?.digital_output_0 !== undefined) {
                const openness = frame.io!.digital_output_0 ? 0 : 1;
                this.animationState.timeline!.call(
                    () => {
                        this.animateGripperOpenness(openness);
                        options.onGripperChange?.(frame.io!.digital_output_0!);
                    },
                    [],
                    timeTick,
                );
            }

            this.animationState.timeline!.call(
                () => {
                    this.animationState.currentKeyFrameIndex = index;
                    options.onStateChange?.(frame.id, frame);
                },
                [],
                timeTick,
            );

            timeTick += frameDuration;
        });

        this.animationState.isPlaying = true;
        this.animationState.isPaused = false;
        this.startTrajectoryRecording();
    }

    pauseAnimation(): void {
        if (this.animationState.timeline && this.animationState.isPlaying) {
            this.animationState.timeline.pause();
            this.animationState.isPaused = true;
            this.stopTrajectoryRecording();
        }
    }

    resumeAnimation(): void {
        if (this.animationState.timeline && this.animationState.isPaused) {
            this.animationState.timeline.play();
            this.animationState.isPaused = false;
            this.startTrajectoryRecording();
        }
    }

    stopAnimation(): void {
        if (this.animationState.timeline) {
            this.animationState.timeline.kill();
            this.animationState.timeline = null;
        }
        this.animationState.isPlaying = false;
        this.animationState.isPaused = false;
        this.animationState.currentProgress = 0;
        this.animationState.currentKeyFrameIndex = 0;
        this.stopTrajectoryRecording();
    }

    stopAllJointAnimations(): void {
        this.jointConfigs.forEach((config) => gsap.killTweensOf(config));
        this.gripperConfigs.forEach((config) => gsap.killTweensOf(config));
    }

    setAnimationProgress(progress: number): void {
        if (this.animationState.isPlaying && !this.animationState.isPaused) return;

        if (!this.animationState.currentSequence) return;

        const sequence = this.animationState.currentSequence;
        const totalDuration = sequence.frames[sequence.frames.length - 1].time;
        const targetTime = totalDuration * progress;

        let targetFrameIndex = 0;
        for (let i = 0; i < sequence.frames.length - 1; i++) {
            if (targetTime >= sequence.frames[i].time && targetTime <= sequence.frames[i + 1].time) {
                targetFrameIndex = i;
                break;
            }
        }
        if (targetTime >= sequence.frames[sequence.frames.length - 1].time) {
            targetFrameIndex = sequence.frames.length - 1;
        }

        const targetFrame = sequence.frames[targetFrameIndex];
        const nextFrame =
            targetFrameIndex < sequence.frames.length - 1 ? sequence.frames[targetFrameIndex + 1] : null;

        let interpolation = 0;
        if (nextFrame) {
            const frameDuration = nextFrame.time - targetFrame.time;
            const frameProgress = targetTime - targetFrame.time;
            interpolation = frameProgress / frameDuration;
        }

        targetFrame.joints.forEach((jointAngle, jointIndex) => {
            if (jointIndex < this.jointNames.length) {
                const jointName = this.jointNames[jointIndex];
                const config = this.jointConfigs.find((c) => c.name === jointName);
                if (config) {
                    let finalAngle = THREE.MathUtils.radToDeg(jointAngle);
                    if (nextFrame && interpolation > 0) {
                        const nextAngle = THREE.MathUtils.radToDeg(nextFrame.joints[jointIndex]);
                        finalAngle = finalAngle + (nextAngle - finalAngle) * interpolation;
                    }
                    config.currentAngle = finalAngle;
                    this.setJointAngle(config.name, config.currentAngle);
                }
            }
        });

        if (targetFrame.io?.digital_output_0 !== undefined) {
            const openness = targetFrame.io!.digital_output_0 ? 0 : 1;
            this.animateGripperOpenness(openness);
        }

        this.animationState.currentProgress = progress;
        this.animationState.currentKeyFrameIndex = targetFrameIndex;
    }

    getAnimationState(): AnimationState {
        return { ...this.animationState };
    }

    getCurrentSequence(): JSONActionSequence | null {
        return this.animationState.currentSequence;
    }

    clearCurrentSequence(): void {
        this.animationState.currentSequence = null;
    }

    getTrajectoryVisualizer(): TrajectoryVisualizer | null {
        return this.trajectoryVisualizer;
    }

    clearTrajectory(): void {
        this.trajectoryVisualizer?.clear();
    }

    private startTrajectoryRecording(): void {
        this.stopTrajectoryRecording();
        const recordInterval = 20;
        this.trajectoryRecordingInterval = window.setInterval(() => {
            this.recordTrajectoryPoint();
        }, recordInterval);
    }

    private stopTrajectoryRecording(): void {
        if (this.trajectoryRecordingInterval !== null) {
            window.clearInterval(this.trajectoryRecordingInterval);
            this.trajectoryRecordingInterval = null;
        }
    }

    private recordTrajectoryPoint(): void {
        const position = TrajectoryVisualizer.getEndEffectorPosition(this.model);
        if (position) {
            const point: TrajectoryPoint = {
                position: position.clone(),
                time: Date.now(),
                frameId: this.currentTrajectoryFrameId++,
            };
            this.trajectoryVisualizer?.addTrajectoryPoint(point);
        }
    }

    dispose(): void {
        this.stopAnimation();
        this.stopAllJointAnimations();
        this.stopTrajectoryRecording();
        this.trajectoryVisualizer?.dispose();

        if (this.directionalLight) {
            this.scene.remove(this.directionalLight);
            this.directionalLight = null;
        }

        const rootToRemove = this.modelContainer ?? this.model;
        if (rootToRemove) {
            this.scene.remove(rootToRemove);
            rootToRemove.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    child.geometry.dispose();
                    if (Array.isArray(child.material)) {
                        child.material.forEach((m) => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
            this.model = null;
            this.modelContainer = null;
        }

        this.joints.clear();
        this.grippers.clear();
        this.jointConfigs = [];
        this.gripperConfigs = [];
        this.allComponentsConfigs = [];
    }
}
