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
    /** Column-major 4x4 world matrix at extraction time */
    worldMatrix: number[];
    /** Reference to the original GLTF mesh for transform sync */
    sourceMesh: THREE.Mesh;
}

// export interface MergedMeshData {
//     position: Float32Array;
//     normal: Float32Array;
//     index: Uint32Array;
//     groups: { start: number; count: number; materialIndex: number }[];
//     /** Unique colors ordered by materialIndex */
//     colors: number[];
// }

export class RobotArm {
    private model: THREE.Group | null = null;
    private joints: Map<string, THREE.Object3D> = new Map();
    private jointConfigs: JointConfig[] = [];
    private jointNames: string[] = [];
    private grippers: Map<string, THREE.Object3D> = new Map();
    private gripperConfigs: JointConfig[] = [];
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
    private groundGrid: THREE.Group | null = null;
    private directionalLight: THREE.DirectionalLight | null = null;
    private onSceneChanged: (() => void) | null = null;
    private onMeshTransformsChanged: ((matrices: Map<THREE.Mesh, number[]>) => void) | null = null;
    private trackedMeshes: THREE.Mesh[] = [];
    private onJointChanged: (() => void) | null = null;
    private mergedSubmeshInfo: {
        sourceMesh: THREE.Mesh;
        vertexOffset: number;
        vertexCount: number;
    }[] = [];
    private mergedTotalVertexCount = 0;

    constructor(
        private scene: THREE.Scene,
        private modelConfig?: RobotModelConfig,
    ) {
        this.loader = new GLTFLoader();
        this.trajectoryVisualizer = new TrajectoryVisualizer(scene);
        if (modelConfig) {
            this.jointNames = modelConfig.joints.map((j) => j.name);
        }
    }

    setOnSceneChanged(callback: (() => void) | null): void {
        this.onSceneChanged = callback;
    }

    setOnMeshTransformsChanged(callback: ((matrices: Map<THREE.Mesh, number[]>) => void) | null): void {
        this.onMeshTransformsChanged = callback;
    }

    // setOnJointChanged(callback: (() => void) | null): void {
    //     this.onJointChanged = callback;
    // }

    /** Notify the consumer that joint transforms have changed */
    private syncMeshNodeTransforms(): void {
        if (!this.onMeshTransformsChanged || this.trackedMeshes.length === 0) return;
        this.modelContainer?.updateMatrixWorld(true);
        const matrices = new Map<THREE.Mesh, number[]>();
        for (const mesh of this.trackedMeshes) {
            matrices.set(mesh, mesh.matrixWorld.toArray());
        }
        this.onMeshTransformsChanged(matrices);
        // this.onJointChanged?.();
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
        //                 ? {
        //                       min: geo.boundingBox.min.toArray(),
        //                       max: geo.boundingBox.max.toArray(),
        //                   }
        //                 : null,
        //         };
        //         const mat = obj.material;
        //         if (Array.isArray(mat)) {
        //             info.materials = mat.map((m) => ({
        //                 type: m.type,
        //                 name: m.name,
        //             }));
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
        //         tracks: a.tracks.map((t) => ({
        //             name: t.name,
        //             type: t.constructor.name,
        //         })),
        //     })),
        //     cameras: gltf.cameras.map((c) => ({ type: c.type, name: c.name })),
        //     userData: gltf.userData,
        //     scene: buildHierarchy(gltf.scene),
        // };

        // const blob = new Blob([JSON.stringify(gltfData, null, 2)], {
        //     type: 'application/json',
        // });
        // const a = document.createElement('a');
        // a.href = URL.createObjectURL(blob);
        // a.download = 'gltf-structure.json';
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

        // Position the model so the robot arm base is at the world origin.
        // If baseNode is configured, use that node's position; otherwise fall back to bounding box center.
        let originOffset: THREE.Vector3;
        if (this.modelConfig?.baseNode) {
            let basePosition: THREE.Vector3 | null = null;
            gltf.scene.traverse((child) => {
                if (child.name === this.modelConfig!.baseNode) {
                    child.updateWorldMatrix(true, false);
                    basePosition = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
                }
            });
            originOffset =
                basePosition ?? new THREE.Box3().setFromObject(gltf.scene).getCenter(new THREE.Vector3());
        } else {
            originOffset = new THREE.Box3().setFromObject(gltf.scene).getCenter(new THREE.Vector3());
        }
        this.model.position.sub(originOffset);

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
        this.syncMeshNodeTransforms();
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
        this.syncMeshNodeTransforms();
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

    getScene(): THREE.Scene {
        return this.scene;
    }

    getJointsMap(): Map<string, THREE.Object3D> {
        return this.joints;
    }

    getJointConfigsRef(): JointConfig[] {
        return this.jointConfigs;
    }

    getModelConfigRef(): RobotModelConfig | undefined {
        return this.modelConfig;
    }

    /** Returns the TCP world position in Chili3D coordinates (after modelContainer transform) */
    getTcpWorldPosition(): THREE.Vector3 | null {
        if (!this.model) return null;

        // Search for a dedicated TCP node
        let tcpNode: THREE.Object3D | null = null;
        const searchNames = ["TCP", "gripper_base"];
        for (const name of searchNames) {
            this.model.traverse((child) => {
                if (!tcpNode && child.name === name) {
                    tcpNode = child;
                }
            });
            if (tcpNode) break;
        }

        // Fallback: use the last joint (or its first child) as TCP
        if (!tcpNode) {
            const jointNames = this.jointConfigs.map((c) => c.name);
            if (jointNames.length > 0) {
                const lastJointName = jointNames[jointNames.length - 1];
                const lastJoint = this.joints.get(lastJointName);
                if (lastJoint) {
                    tcpNode = lastJoint.children[0] ?? lastJoint;
                }
            }
        }

        if (!tcpNode) return null;
        this.modelContainer?.updateMatrixWorld(true);
        return new THREE.Vector3().setFromMatrixPosition(tcpNode.matrixWorld);
    }

    /**
     * Returns the TCP world pose: position (x,y,z) and orientation as WPR (degrees).
     * W = rotation around Z, P = rotation around Y, R = rotation around X.
     * Convention: intrinsic ZYX Euler angles (yaw-pitch-roll).
     */
    getTcpWorldPose(): { x: number; y: number; z: number; w: number; p: number; r: number } | null {
        if (!this.model) return null;

        let tcpNode: THREE.Object3D | null = null;
        const searchNames = this.modelConfig?.tcpNode
            ? [this.modelConfig.tcpNode, "TCP", "gripper_base"]
            : ["TCP", "gripper_base"];
        for (const name of searchNames) {
            this.model.traverse((child) => {
                if (!tcpNode && child.name === name) {
                    tcpNode = child;
                }
            });
            if (tcpNode) break;
        }

        if (!tcpNode) {
            const jointNames = this.jointConfigs.map((c) => c.name);
            if (jointNames.length > 0) {
                const lastJointName = jointNames[jointNames.length - 1];
                const lastJoint = this.joints.get(lastJointName);
                if (lastJoint) {
                    tcpNode = lastJoint.children[0] ?? lastJoint;
                }
            }
        }

        if (!tcpNode) return null;
        this.modelContainer?.updateMatrixWorld(true);

        const pos = new THREE.Vector3().setFromMatrixPosition(tcpNode.matrixWorld);
        const quat = new THREE.Quaternion();
        tcpNode.getWorldQuaternion(quat);
        // ZYX intrinsic = 'ZYX' order in Three.js Euler
        const euler = new THREE.Euler().setFromQuaternion(quat, "ZYX");

        return {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            w: THREE.MathUtils.radToDeg(euler.z),
            p: THREE.MathUtils.radToDeg(euler.y),
            r: THREE.MathUtils.radToDeg(euler.x),
        };
    }

    /** Sets a joint angle without triggering scene update or mesh sync callbacks.
     *  Used by IK solver to batch-update multiple joints before a single sync.
     */
    setJointAngleSilent(jointName: string, angle: number): void {
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
    }

    /** Triggers mesh sync and scene update after batch joint changes (e.g. from IK solver) */
    notifyJointsChanged(): void {
        this.syncMeshNodeTransforms();
        this.onSceneChanged?.();
    }

    toggleGroundGrid(visible?: boolean): void {
        const show = visible !== undefined ? visible : !this.groundGrid?.visible;

        if (show && !this.groundGrid) {
            this.groundGrid = this.createGroundGrid();
            this.scene.add(this.groundGrid);
        }
        if (this.groundGrid) {
            this.groundGrid.visible = show;
        }
        this.onSceneChanged?.();
    }

    private createGroundGrid(): THREE.Group {
        const group = new THREE.Group();
        const gridSize = 20000;
        const divisions = 40;
        const cellSize = gridSize / divisions;

        // White ground plane
        const planeGeo = new THREE.PlaneGeometry(gridSize, gridSize);
        const planeMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
        });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        // Chili3D is Z-up, PlaneGeometry faces Z by default — no rotation needed
        group.add(plane);

        // Black grid lines
        const vertices: number[] = [];
        const half = gridSize / 2;
        for (let i = 0; i <= divisions; i++) {
            const pos = -half + i * cellSize;
            // Lines along X
            vertices.push(pos, -half, 0, pos, half, 0);
            // Lines along Y
            vertices.push(-half, pos, 0, half, pos, 0);
        }
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
        const lineMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const lines = new THREE.LineSegments(lineGeo, lineMat);
        lines.position.z = 0.5; // Slightly above the plane to avoid z-fighting
        group.add(lines);

        // Origin axes helper (visible above the ground plane)
        const axesSize = 200;
        const axes = new THREE.AxesHelper(axesSize);
        axes.position.z = 1; // Above the plane and grid lines
        group.add(axes);

        // Origin label "(0, 0, 0)"
        const originLabel = this.createTextSprite("(0, 0, 0)", 80);
        originLabel.position.set(0, 0, 2);
        group.add(originLabel);

        return group;
    }

    private createTextSprite(text: string, size: number): THREE.Sprite {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        const fontSize = 64;
        ctx.font = `bold ${fontSize}px Arial`;
        const metrics = ctx.measureText(text);
        canvas.width = Math.ceil(metrics.width) + 16;
        canvas.height = fontSize + 16;
        // Redraw after resizing canvas (resize clears it)
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.fillStyle = "#000000";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 8, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({
            map: texture,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(mat);
        const aspect = canvas.width / canvas.height;
        sprite.scale.set(size * aspect, size, 1);
        return sprite;
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
     * Extracts local geometry and world matrix from each mesh in the robot model.
     * Geometry stays in local space — the world matrix is provided separately
     * so MeshNode transforms can be updated when joints move.
     */
    extractRobotMeshData(): ExtractedMeshData[] {
        if (!this.modelContainer) return [];

        this.modelContainer.updateMatrixWorld(true);
        const results: ExtractedMeshData[] = [];

        this.modelContainer.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;

            const geo = child.geometry as THREE.BufferGeometry;
            const posAttr = geo.attributes.position;
            if (!posAttr) return;

            const position = new Float32Array(posAttr.array);
            const normAttr = geo.attributes.normal;
            const normal = normAttr ? new Float32Array(normAttr.array) : new Float32Array(posAttr.count * 3);

            let index: Uint32Array;
            if (geo.index) {
                index = new Uint32Array(geo.index.array);
            } else {
                index = new Uint32Array(posAttr.count);
                for (let i = 0; i < posAttr.count; i++) index[i] = i;
            }

            let color = 0xff8c00;
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
                worldMatrix: child.matrixWorld.toArray(),
                sourceMesh: child,
            });
        });

        this.trackedMeshes = results.map((r) => r.sourceMesh);
        return results;
    }

    /**
     * Merges all GLTF meshes into a single geometry with world-baked vertices.
     * Each unique color becomes a MeshGroup with its own materialIndex.
     */
    // extractMergedMeshData(): MergedMeshData | null {
    //     if (!this.modelContainer) return null;
    //     this.modelContainer.updateMatrixWorld(true);

    //     const allPositions: number[] = [];
    //     const allNormals: number[] = [];
    //     const allIndices: number[] = [];
    //     const groups: {
    //         start: number;
    //         count: number;
    //         materialIndex: number;
    //     }[] = [];
    //     const colorToIndex = new Map<number, number>();
    //     const colors: number[] = [];
    //     const submeshInfo: {
    //         sourceMesh: THREE.Mesh;
    //         vertexOffset: number;
    //         vertexCount: number;
    //     }[] = [];

    //     let vertexOffset = 0;
    //     let indexOffset = 0;
    //     const v = new THREE.Vector3();
    //     const n = new THREE.Vector3();

    //     this.modelContainer.traverse((child) => {
    //         if (!(child instanceof THREE.Mesh)) return;
    //         const geo = child.geometry as THREE.BufferGeometry;
    //         const posAttr = geo.attributes.position;
    //         if (!posAttr) return;

    //         const vertexCount = posAttr.count;

    //         // Determine color
    //         let color = 0xff8c00;
    //         const mat = Array.isArray(child.material)
    //             ? child.material[0]
    //             : child.material;
    //         if (mat instanceof THREE.MeshStandardMaterial && mat.color) {
    //             color = mat.color.getHex();
    //         }
    //         if (!colorToIndex.has(color)) {
    //             colorToIndex.set(color, colors.length);
    //             colors.push(color);
    //         }
    //         const materialIndex = colorToIndex.get(color)!;

    //         // Transform positions and normals by world matrix
    //         const worldMatrix = child.matrixWorld;
    //         const normalMatrix = new THREE.Matrix3().getNormalMatrix(
    //             worldMatrix
    //         );

    //         for (let i = 0; i < vertexCount; i++) {
    //             v.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
    //             allPositions.push(v.x, v.y, v.z);

    //             const normAttr = geo.attributes.normal;
    //             if (normAttr) {
    //                 n.fromBufferAttribute(normAttr, i)
    //                     .applyMatrix3(normalMatrix)
    //                     .normalize();
    //             } else {
    //                 n.set(0, 0, 1);
    //             }
    //             allNormals.push(n.x, n.y, n.z);
    //         }

    //         // Indices
    //         const indexStart = indexOffset;
    //         if (geo.index) {
    //             const idxArr = geo.index.array;
    //             for (let i = 0; i < idxArr.length; i++) {
    //                 allIndices.push(idxArr[i] + vertexOffset);
    //             }
    //             indexOffset += idxArr.length;
    //         } else {
    //             for (let i = 0; i < vertexCount; i++) {
    //                 allIndices.push(i + vertexOffset);
    //             }
    //             indexOffset += vertexCount;
    //         }

    //         groups.push({
    //             start: indexStart,
    //             count: indexOffset - indexStart,
    //             materialIndex,
    //         });
    //         submeshInfo.push({ sourceMesh: child, vertexOffset, vertexCount });
    //         vertexOffset += vertexCount;
    //     });

    //     this.mergedSubmeshInfo = submeshInfo;
    //     this.mergedTotalVertexCount = vertexOffset;

    //     return {
    //         position: new Float32Array(allPositions),
    //         normal: new Float32Array(allNormals),
    //         index: new Uint32Array(allIndices),
    //         groups,
    //         colors,
    //     };
    // }

    /**
     * Re-bakes vertex positions and normals from the current GLTF world matrices.
     * Call this after joints change to update the merged mesh in-place.
     */
    // rebuildMergedPositions(): {
    //     position: Float32Array;
    //     normal: Float32Array;
    // } | null {
    //     if (this.mergedSubmeshInfo.length === 0) return null;
    //     this.modelContainer?.updateMatrixWorld(true);

    //     const position = new Float32Array(this.mergedTotalVertexCount * 3);
    //     const normal = new Float32Array(this.mergedTotalVertexCount * 3);
    //     const v = new THREE.Vector3();
    //     const n = new THREE.Vector3();

    //     for (const { sourceMesh, vertexOffset, vertexCount } of this
    //         .mergedSubmeshInfo) {
    //         const geo = sourceMesh.geometry as THREE.BufferGeometry;
    //         const posAttr = geo.attributes.position;
    //         const normAttr = geo.attributes.normal;
    //         const worldMatrix = sourceMesh.matrixWorld;
    //         const normalMatrix = new THREE.Matrix3().getNormalMatrix(
    //             worldMatrix
    //         );
    //         const baseIdx = vertexOffset * 3;

    //         for (let i = 0; i < vertexCount; i++) {
    //             v.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
    //             const idx = baseIdx + i * 3;
    //             position[idx] = v.x;
    //             position[idx + 1] = v.y;
    //             position[idx + 2] = v.z;

    //             if (normAttr) {
    //                 n.fromBufferAttribute(normAttr, i)
    //                     .applyMatrix3(normalMatrix)
    //                     .normalize();
    //             } else {
    //                 n.set(0, 0, 1);
    //             }
    //             normal[idx] = n.x;
    //             normal[idx + 1] = n.y;
    //             normal[idx + 2] = n.z;
    //         }
    //     }

    //     return { position, normal };
    // }

    /** Hide the original GLTF meshes so only the Chili3D MeshNode versions render */
    hideGltfMeshes(): void {
        this.modelContainer?.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.visible = false;
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
        if (this.groundGrid) {
            this.scene.remove(this.groundGrid);
            this.groundGrid.traverse((child) => {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                    child.geometry.dispose();
                    if (Array.isArray(child.material)) {
                        for (const m of child.material) m.dispose();
                    } else {
                        child.material.dispose();
                    }
                }
            });
            this.groundGrid = null;
        }

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
        this.trackedMeshes = [];
        // this.mergedSubmeshInfo = [];
        // this.mergedTotalVertexCount = 0;
    }
}
