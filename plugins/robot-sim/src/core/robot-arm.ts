// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import gsap from "gsap";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type {
    AnimationState,
    JointConfig,
    JSONActionSequence,
    JSONKeyFrame,
    RobotModelConfig,
} from "./joint-config";
import { type TrajectoryPoint, TrajectoryVisualizer } from "./trajectory-visualizer";

export interface ExtractedMeshData {
    name: string;
    position: Float32Array;
    normal: Float32Array;
    index: Uint32Array;
    color: number;
}

export class RobotArm {
    private model: THREE.Group | null = null;
    private joints: Map<string, THREE.Object3D> = new Map();
    private jointConfigs: JointConfig[] = [];
    private jointNames: string[] = [];
    private grippers: Map<string, THREE.Object3D> = new Map();
    private gripperConfigs: JointConfig[] = [];
    private gripperNames: string[] = [];
    private allComponentsConfigs: JointConfig[] = [];
    private jointDefaultPositions: Map<string, THREE.Vector3> = new Map();
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
    private constantLinearVelocity: number = 200;
    private trajectoryVisualizer: TrajectoryVisualizer | null = null;
    private trajectoryRecordingInterval: number | null = null;
    private currentTrajectoryFrameId: number = 0;
    private modelContainer: THREE.Group | null = null;
    private tcpGizmo: THREE.AxesHelper | null = null;
    // private gridHelper: THREE.GridHelper | null = null;
    private robotSubtree: THREE.Object3D | null = null;
    private isRobotSelected = false;
    private savedMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]> = new Map();
    private directionalLight: THREE.DirectionalLight | null = null;
    private onSceneChanged: (() => void) | null = null;

    constructor(
        private scene: THREE.Scene,
        private modelConfig?: RobotModelConfig,
    ) {
        this.loader = new GLTFLoader();
        this.trajectoryVisualizer = new TrajectoryVisualizer(scene);
        if (modelConfig) {
            this.jointNames = modelConfig.joints.map((j) => j.name);
            this.gripperNames = (modelConfig.grippers ?? []).map((g) => g.name);
        }
    }

    setOnSceneChanged(callback: (() => void) | null): void {
        this.onSceneChanged = callback;
    }

    async loadModelFromUrl(url: string): Promise<void> {
        const gltf = await this.loader.loadAsync(url);

        // Save GLTF structure to a JSON file for inspection
        // const buildHierarchy = (obj: THREE.Object3D): object => {
        //     const info: Record<string, unknown> = {
        //         type: obj.type,
        //         name: obj.name,
        //         position: obj.position.toArray(),
        //         rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        //         scale: obj.scale.toArray(),
        //     };
        //     if (obj instanceof THREE.Mesh) {
        //         const geo = obj.geometry;
        //         info.geometry = {
        //             vertices: geo.attributes.position?.count ?? 0,
        //             normals: !!geo.attributes.normal,
        //             uvs: !!geo.attributes.uv,
        //             indices: geo.index ? geo.index.count : 0,
        //             boundingBox: geo.boundingBox
        //                 ? { min: geo.boundingBox.min.toArray(), max: geo.boundingBox.max.toArray() }
        //                 : null,
        //         };
        //         const mat = obj.material;
        //         if (Array.isArray(mat)) {
        //             info.materials = mat.map((m) => ({ type: m.type, name: m.name }));
        //         } else {
        //             info.material = { type: mat.type, name: mat.name };
        //         }
        //     }
        //     if (obj.children.length > 0) {
        //         info.children = obj.children.map(buildHierarchy);
        //     }
        //     return info;
        // };

        // const gltfData = {
        //     asset: gltf.asset,
        //     animations: gltf.animations.map((a) => ({
        //         name: a.name,
        //         duration: a.duration,
        //         tracks: a.tracks.map((t) => ({ name: t.name, type: t.constructor.name })),
        //     })),
        //     cameras: gltf.cameras.map((c) => ({ type: c.type, name: c.name })),
        //     userData: gltf.userData,
        //     scene: buildHierarchy(gltf.scene),
        // };

        // const blob = new Blob([JSON.stringify(gltfData, null, 2)], { type: "application/json" });
        // const a = document.createElement("a");
        // a.href = URL.createObjectURL(blob);
        // a.download = "gltf-structure.json";
        // a.click();
        // URL.revokeObjectURL(a.href);

        this.model = gltf.scene;

        // Wrap model in a container to handle Y-up to Z-up conversion.
        // Chili3D uses Z-up (Object3D.DEFAULT_UP = 0,0,1), robot models are Y-up.
        this.modelContainer = new THREE.Group();
        if (this.modelConfig?.transform.yUpToZUp !== false) {
            this.modelContainer.rotation.x = Math.PI / 2;
        }

        const scaleFactor = this.modelConfig?.transform.scale ?? 100;
        this.modelContainer.scale.setScalar(scaleFactor);

        // Center the model at the origin by offsetting its bounding box center
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        this.model.position.sub(center);

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
        if (!this.model || !this.modelConfig) return;

        this.joints.clear();
        this.grippers.clear();
        this.jointConfigs = [];
        this.gripperConfigs = [];
        this.jointDefaultPositions.clear();

        // Setup mesh shadows on the full model
        this.model.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.receiveShadow = false;
                child.castShadow = true;
            }
        });

        // Determine the root node for joint traversal
        let traverseRoot: THREE.Object3D = this.model;
        if (this.modelConfig.kinematicRoot) {
            const rootName = this.modelConfig.kinematicRoot;
            let found = false;
            this.model.traverse((child) => {
                if (child.name === rootName) {
                    traverseRoot = child;
                    found = true;
                }
            });
            console.log(`[RobotSim] kinematicRoot "${rootName}" ${found ? "found" : "NOT found"} in model`);
        }

        const scaleFactor = this.modelConfig.transform.scale ?? 1;
        const jointConfigMap = new Map(this.modelConfig.joints.map((j) => [j.name, j]));
        const gripperConfigMap = new Map((this.modelConfig.grippers ?? []).map((g) => [g.name, g]));

        console.log("[RobotSim] Looking for joints:", [...jointConfigMap.keys()]);

        traverseRoot.traverse((child) => {
            const jointDef = jointConfigMap.get(child.name);
            if (jointDef) {
                const helper = new THREE.AxesHelper(0.1);
                helper.visible = false;
                child.add(helper);
                this.joints.set(child.name, child);

                let currentValue: number;
                if (jointDef.type === "linear") {
                    const axisKey = jointDef.axis.toLowerCase() as "x" | "y" | "z";
                    currentValue = child.position[axisKey] * scaleFactor;
                    this.jointDefaultPositions.set(child.name, child.position.clone());
                } else {
                    currentValue = THREE.MathUtils.radToDeg(
                        child.rotation[jointDef.axis.toLowerCase() as keyof THREE.Euler] as number,
                    );
                }

                this.jointConfigs.push({
                    name: child.name,
                    axis: jointDef.axis,
                    type: jointDef.type,
                    minAngle: jointDef.min,
                    maxAngle: jointDef.max,
                    defaultAngle: jointDef.default ?? currentValue,
                    currentAngle: currentValue,
                });
            }

            const gripperDef = gripperConfigMap.get(child.name);
            if (gripperDef) {
                const helper = new THREE.AxesHelper(0.1);
                helper.visible = false;
                child.add(helper);
                this.grippers.set(child.name, child);

                const currentAngle = THREE.MathUtils.radToDeg(
                    child.rotation[gripperDef.axis.toLowerCase() as keyof THREE.Euler] as number,
                );

                this.gripperConfigs.push({
                    name: child.name,
                    axis: gripperDef.axis,
                    type: gripperDef.type,
                    minAngle: gripperDef.min,
                    maxAngle: gripperDef.max,
                    defaultAngle: gripperDef.default ?? currentAngle,
                    currentAngle,
                });
            }
        });

        // Reparent linked visual nodes under their kinematic joints.
        // This ensures the kinematic chain propagates transforms to visual geometry.
        // Collect first, then reparent — modifying the scene graph during traverse crashes.
        const reparentQueue: {
            joint: THREE.Object3D;
            visual: THREE.Object3D;
        }[] = [];
        for (const jointDef of this.modelConfig.joints) {
            if (jointDef.linkedVisualNodes && jointDef.linkedVisualNodes.length > 0) {
                const kinematicJoint = this.joints.get(jointDef.name);
                if (!kinematicJoint) continue;
                const visualNames = new Set(jointDef.linkedVisualNodes);
                this.model.traverse((child) => {
                    if (visualNames.has(child.name)) {
                        reparentQueue.push({
                            joint: kinematicJoint,
                            visual: child,
                        });
                    }
                });
            }
        }
        for (const { joint, visual } of reparentQueue) {
            joint.attach(visual);
        }

        this.allComponentsConfigs = [...this.jointConfigs, ...this.gripperConfigs];
        console.log(
            `[RobotSim] Initialized ${this.jointConfigs.length} joints, ${this.gripperConfigs.length} grippers`,
            this.jointConfigs.map((c) => c.name),
        );

        // Find the robot arm subtree for selection
        this.model.traverse((child) => {
            if (child.name === "Robot_SA122000H") {
                this.robotSubtree = child;
            }
        });

        // Attach a visible axes gizmo to the TCP node (Z = torch direction)
        // Swap X and Y axes so the gizmo matches the expected orientation
        this.model.traverse((child) => {
            if (child.name === "TCP") {
                this.tcpGizmo = new THREE.AxesHelper(0.1);
                const swapGroup = new THREE.Group();
                swapGroup.matrix.set(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
                swapGroup.matrixAutoUpdate = false;
                swapGroup.add(this.tcpGizmo);
                child.add(swapGroup);
                console.log("[RobotSim] TCP gizmo attached");
            }
        });
    }

    /** Returns all meshes in the robot model for raycasting */
    getRaycastTargets(): THREE.Object3D[] {
        const targets: THREE.Object3D[] = [];
        this.modelContainer?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                targets.push(child);
            }
        });
        return targets;
    }

    /** Returns meshes belonging to the Robot_SA122000H subtree */
    getRobotArmTargets(): THREE.Object3D[] {
        const targets: THREE.Object3D[] = [];
        this.robotSubtree?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                targets.push(child);
            }
        });
        return targets;
    }

    /** Check if a mesh belongs to the Robot_SA122000H subtree */
    isRobotArmMesh(mesh: THREE.Object3D): boolean {
        if (!this.robotSubtree) return false;
        let current: THREE.Object3D | null = mesh;
        while (current) {
            if (current === this.robotSubtree) return true;
            current = current.parent;
        }
        return false;
    }

    /** Toggle selection highlight on the robot arm */
    selectRobotArm(selected: boolean): void {
        if (this.isRobotSelected === selected) return;
        this.isRobotSelected = selected;

        if (!this.robotSubtree) return;

        if (selected) {
            this.robotSubtree.traverse((child) => {
                if (child instanceof THREE.Mesh) {
                    this.savedMaterials.set(child, child.material);
                    const originalMat = Array.isArray(child.material) ? child.material[0] : child.material;
                    const highlightMat = (originalMat as THREE.MeshStandardMaterial).clone();
                    highlightMat.emissive = new THREE.Color(0x335599);
                    highlightMat.emissiveIntensity = 0.4;
                    child.material = highlightMat;
                }
            });
        } else {
            this.savedMaterials.forEach((mat, mesh) => {
                mesh.material = mat;
            });
            this.savedMaterials.clear();
        }

        this.onSceneChanged?.();
    }

    getIsRobotSelected(): boolean {
        return this.isRobotSelected;
    }

    setJointAngle(jointName: string, angle: number): void {
        const joint = this.joints.get(jointName);
        const config = this.jointConfigs.find((c) => c.name === jointName);
        if (!joint || !config) return;

        const clampedAngle = Math.max(config.minAngle, Math.min(config.maxAngle, angle));
        config.currentAngle = clampedAngle;

        const axisKey = config.axis.toLowerCase() as "x" | "y" | "z";
        if (config.type === "linear") {
            const defaultPos = this.jointDefaultPositions.get(jointName);
            if (defaultPos) {
                const scaleFactor = this.modelConfig?.transform.scale ?? 1;
                joint.position[axisKey] = defaultPos[axisKey] + clampedAngle / scaleFactor;
            }
        } else {
            const rad = THREE.MathUtils.degToRad(clampedAngle);
            joint.rotation[axisKey as keyof THREE.Euler] = rad as any;
        }
        this.onSceneChanged?.();
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
                this.animationState.timeline?.to(
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

        const axisKey = config.axis.toLowerCase() as "x" | "y" | "z";
        if (config.type === "linear") {
            const defaultPos = this.jointDefaultPositions.get(gripperName);
            if (defaultPos) {
                const scaleFactor = this.modelConfig?.transform.scale ?? 1;
                gripper.position[axisKey] = defaultPos[axisKey] + clampedAngle / scaleFactor;
            }
        } else {
            const rad = THREE.MathUtils.degToRad(clampedAngle);
            gripper.rotation[axisKey as keyof THREE.Euler] = rad as any;
        }
        this.onSceneChanged?.();
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

    getModelContainer(): THREE.Group | null {
        return this.modelContainer;
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

        // const show = visible !== undefined ? visible : !this.gridHelper?.visible;
        // if (show && !this.gridHelper && this.modelContainer) {
        //     const size = 5;
        //     const divisions = 50;
        //     this.gridHelper = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
        //     // GridHelper is created in XZ plane (Y-up), rotate to XY plane (Z-up)
        //     this.gridHelper.rotation.x = Math.PI / 2;
        //     this.modelContainer.add(this.gridHelper);
        // }
        // if (this.gridHelper) {
        //     this.gridHelper.visible = show;
        // }
        // this.onSceneChanged?.();
    }

    reset0(options?: { onUpdate?: (config: JointConfig) => void; onComplete?: () => void }): void {
        this.stopAllJointAnimations();
        this.allComponentsConfigs.forEach((config) => {
            gsap.killTweensOf(config, "currentAngle");
            const velocity =
                config.type === "linear" ? this.constantLinearVelocity : this.constantAngularVelocity;
            const duration = Math.abs(config.currentAngle - 0) / velocity;
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
            const velocity =
                config.type === "linear" ? this.constantLinearVelocity : this.constantAngularVelocity;
            const duration = Math.abs(config.currentAngle - config.defaultAngle) / velocity;
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

        const sequence = this.animationState.currentSequence;
        if (!sequence) return;
        this.stopAnimation();

        const sequenceId = `${sequence.meta.description}_${sequence.meta.created}`;
        this.trajectoryVisualizer?.startNewTrajectory(sequenceId);
        this.currentTrajectoryFrameId = 0;

        this.animationState.timeline = gsap.timeline({
            onUpdate: () => {
                const progress = this.animationState.timeline?.progress();
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
                        const scaleFactor = this.modelConfig?.transform.scale ?? 1;
                        const targetAngle =
                            config.type === "linear"
                                ? angleRad * scaleFactor
                                : THREE.MathUtils.radToDeg(angleRad);
                        this.animationState.timeline?.to(
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
                const openness = frame.io?.digital_output_0 ? 0 : 1;
                this.animationState.timeline?.call(
                    () => {
                        this.animateGripperOpenness(openness);
                        options.onGripperChange?.(frame.io?.digital_output_0 ?? false);
                    },
                    [],
                    timeTick,
                );
            }

            this.animationState.timeline?.call(
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
        for (const config of this.jointConfigs) gsap.killTweensOf(config);
        for (const config of this.gripperConfigs) gsap.killTweensOf(config);
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
                    const scaleFactor = this.modelConfig?.transform.scale ?? 1;
                    const convert = (v: number) =>
                        config.type === "linear" ? v * scaleFactor : THREE.MathUtils.radToDeg(v);
                    let finalAngle = convert(jointAngle);
                    if (nextFrame && interpolation > 0) {
                        const nextAngle = convert(nextFrame.joints[jointIndex]);
                        finalAngle = finalAngle + (nextAngle - finalAngle) * interpolation;
                    }
                    config.currentAngle = finalAngle;
                    this.setJointAngle(config.name, config.currentAngle);
                }
            }
        });

        if (targetFrame.io?.digital_output_0 !== undefined) {
            const openness = targetFrame.io?.digital_output_0 ? 0 : 1;
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

    /**
     * Extract mesh data from Robot_SA122000H subtree for creating Chili3D MeshNodes.
     * Bakes world transforms into vertex positions/normals so nodes can use identity transform.
     */
    extractRobotArmMeshes(): ExtractedMeshData[] {
        if (!this.robotSubtree || !this.modelContainer) return [];

        const results: ExtractedMeshData[] = [];
        const normalMatrix = new THREE.Matrix3();

        this.robotSubtree.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;

            const geo = child.geometry as THREE.BufferGeometry;
            const posAttr = geo.attributes.position;
            const normAttr = geo.attributes.normal;
            if (!posAttr) return;

            // Compute world matrix including modelContainer's scale and rotation
            child.updateWorldMatrix(true, false);
            const worldMatrix = child.matrixWorld.clone();
            normalMatrix.getNormalMatrix(worldMatrix);

            // Extract and transform positions
            const vertexCount = posAttr.count;
            const position = new Float32Array(vertexCount * 3);
            const tempVec = new THREE.Vector3();
            for (let i = 0; i < vertexCount; i++) {
                tempVec.fromBufferAttribute(posAttr, i);
                tempVec.applyMatrix4(worldMatrix);
                position[i * 3] = tempVec.x;
                position[i * 3 + 1] = tempVec.y;
                position[i * 3 + 2] = tempVec.z;
            }

            // Extract and transform normals
            const normal = new Float32Array(vertexCount * 3);
            if (normAttr) {
                const tempNorm = new THREE.Vector3();
                for (let i = 0; i < vertexCount; i++) {
                    tempNorm.fromBufferAttribute(normAttr, i);
                    tempNorm.applyMatrix3(normalMatrix).normalize();
                    normal[i * 3] = tempNorm.x;
                    normal[i * 3 + 1] = tempNorm.y;
                    normal[i * 3 + 2] = tempNorm.z;
                }
            }

            // Extract indices
            let index: Uint32Array;
            if (geo.index) {
                index = new Uint32Array(geo.index.array);
            } else {
                index = new Uint32Array(vertexCount);
                for (let i = 0; i < vertexCount; i++) index[i] = i;
            }

            // Extract color from material
            let color = 0xff8c00; // Default orange
            const mat = Array.isArray(child.material) ? child.material[0] : child.material;
            if (mat instanceof THREE.MeshStandardMaterial && mat.color) {
                color = mat.color.getHex();
            }

            results.push({
                name: child.name || `mesh_${results.length}`,
                position,
                normal,
                index,
                color,
            });
        });

        return results;
    }

    /** Hide the original Robot_SA122000H meshes so only the MeshNode version renders */
    hideRobotArmMeshes(): void {
        this.robotSubtree?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.visible = false;
            }
        });
    }

    /** Show the original Robot_SA122000H meshes */
    showRobotArmMeshes(): void {
        this.robotSubtree?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.visible = true;
            }
        });
    }

    dispose(): void {
        this.stopAnimation();
        this.stopAllJointAnimations();
        this.stopTrajectoryRecording();
        this.trajectoryVisualizer?.dispose();

        if (this.tcpGizmo) {
            this.tcpGizmo.dispose();
            this.tcpGizmo = null;
        }
        // if (this.gridHelper) {
        //     this.gridHelper.dispose();
        //     this.gridHelper = null;
        // }

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
                        for (const m of child.material) m.dispose();
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
        this.jointDefaultPositions.clear();
        this.savedMaterials.clear();
        this.robotSubtree = null;
        this.isRobotSelected = false;
    }
}
