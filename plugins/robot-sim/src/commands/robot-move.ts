// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    Matrix4,
    PubSub,
    Transaction,
    VisualNode,
} from "@chili3d/core";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { IKSolver } from "../core/ik-solver";
import { extractKinematicChain } from "../core/robot-kinematics";
import { getRobotArm } from "../core/robot-registry";

/** Checks whether the selected nodes belong to a loaded robot arm */
function getSelectedRobotNodes(application: IApplication): VisualNode[] | null {
    const doc = application.activeView?.document;
    if (!doc) return null;
    const robotArm = getRobotArm(doc);
    if (!robotArm) return null;

    const selected = doc.selection.getSelectedNodes();
    if (selected.length === 0) return null;

    const hasRobotNode = selected.some((n) => {
        const parent = (n as any).parent;
        return parent && parent.name === robotArm.getModelConfigRef()?.displayName;
    });

    if (!hasRobotNode) return null;
    return selected.filter((x) => x instanceof VisualNode);
}

function getThreeContext(application: IApplication) {
    const view = application.activeView;
    const doc = view?.document;
    if (!doc || !view) return null;
    const visual = doc.visual as any;
    return {
        scene: visual.scene as THREE.Scene,
        camera: (view as any).camera as THREE.Camera,
        dom: view.dom as HTMLElement,
        view,
        document: doc,
        visual,
    };
}

/**
 * Creates dual TransformControls gizmos for robot manipulation:
 * - Base gizmo: moves/rotates the whole robot (with ghost preview)
 * - TCP gizmo: drives IK to position the end-effector
 */
export function createRobotDualGizmos(
    application: IApplication,
    mode: "translate" | "rotate",
): Promise<void> {
    const ctx = getThreeContext(application);
    if (!ctx) return Promise.resolve();

    const robotArm = getRobotArm(ctx.document);
    if (!robotArm) return Promise.resolve();

    const model = robotArm.getModel();
    const modelContainer = robotArm.getModelContainer();
    if (!model || !modelContainer) return Promise.resolve();

    // Build kinematic chain for IK
    const ikConfig = robotArm.getModelConfigRef();
    const chain = extractKinematicChain(
        robotArm.getJointsMap(),
        robotArm.getJointConfigsRef(),
        model,
        ikConfig?.tcpNode,
    );
    const solver = new IKSolver();

    // --- Base gizmo (move/rotate whole robot) ---
    modelContainer.updateMatrixWorld(true);
    const basePos = new THREE.Vector3().setFromMatrixPosition(modelContainer.matrixWorld);

    const baseAnchor = new THREE.Group();
    baseAnchor.position.copy(basePos);
    ctx.scene.add(baseAnchor);

    const baseControls = new TransformControls(ctx.camera, ctx.dom);
    baseControls.setMode(mode);
    baseControls.setSize(1.2);
    baseControls.attach(baseAnchor);
    ctx.scene.add(baseControls.getHelper());

    // Build ghost clone for base gizmo preview
    const ghostMaterial = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
    });
    const ghostGroup = new THREE.Group();
    ghostGroup.position.copy(basePos);
    const centerOffset = new THREE.Matrix4().makeTranslation(-basePos.x, -basePos.y, -basePos.z);

    modelContainer.updateMatrixWorld(true);
    modelContainer.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
            const ghost = new THREE.Mesh(child.geometry, ghostMaterial);
            ghost.matrixAutoUpdate = false;
            ghost.matrix.copy(new THREE.Matrix4().multiplyMatrices(centerOffset, child.matrixWorld));
            ghost.matrixWorld.copy(child.matrixWorld);
            ghostGroup.add(ghost);
        }
    });
    ctx.scene.add(ghostGroup);

    // --- TCP gizmo (IK) ---
    const tcpPos = robotArm.getTcpWorldPosition();
    const tcpAnchor = new THREE.Group();
    if (tcpPos) {
        tcpAnchor.position.copy(tcpPos);
    }
    // Sync initial TCP orientation from the kinematic chain
    if (chain) {
        chain.tcpNode.updateWorldMatrix(true, false);
        const tcpQuat = new THREE.Quaternion();
        chain.tcpNode.getWorldQuaternion(tcpQuat);
        tcpAnchor.quaternion.copy(tcpQuat);
    }
    ctx.scene.add(tcpAnchor);

    const tcpControls = new TransformControls(ctx.camera, ctx.dom);
    tcpControls.setMode("translate");
    tcpControls.setSize(0.8);
    tcpControls.attach(tcpAnchor);
    ctx.scene.add(tcpControls.getHelper());

    /** Current gizmo mode for TCP and J6 */
    let ikGizmoMode: "translate" | "rotate" = "translate";

    // Disable camera rotation while dragging any gizmo
    const setViewEnabled = (enabled: boolean) => {
        ctx.visual.viewHandler.isEnabled = enabled;
    };

    // --- Joint 6 gizmo (IK targeting the last joint) ---
    const jointConfigs = robotArm.getJointConfigsRef();
    const jointsMap = robotArm.getJointsMap();

    let j6Controls: TransformControls | null = null;
    let j6Anchor: THREE.Group | null = null;
    let j6Chain: ReturnType<typeof extractKinematicChain> = null;
    const j6Solver = new IKSolver();

    if (jointConfigs.length >= 2) {
        const lastJointConfig = jointConfigs[jointConfigs.length - 1];
        const lastJointObj = jointsMap.get(lastJointConfig.name);

        if (lastJointObj) {
            // Build partial chain: joints 0..N-2 solving toward joint N-1
            const partialConfigs = jointConfigs.slice(0, -1);
            j6Chain = extractKinematicChain(jointsMap, partialConfigs, model, lastJointConfig.name);

            // If extractKinematicChain couldn't find the node by name, build manually
            if (j6Chain && j6Chain.tcpNode !== lastJointObj) {
                j6Chain = { joints: j6Chain.joints, tcpNode: lastJointObj };
            }

            lastJointObj.updateWorldMatrix(true, false);
            const j6Pos = new THREE.Vector3().setFromMatrixPosition(lastJointObj.matrixWorld);

            j6Anchor = new THREE.Group();
            j6Anchor.position.copy(j6Pos);
            ctx.scene.add(j6Anchor);

            j6Controls = new TransformControls(ctx.camera, ctx.dom);
            j6Controls.setMode("translate");
            j6Controls.setSize(0.6);
            j6Controls.attach(j6Anchor);
            ctx.scene.add(j6Controls.getHelper());

            j6Controls.addEventListener("dragging-changed", (event: any) => {
                setViewEnabled(!event.value);
                if (event.value) {
                    lastJointObj.updateWorldMatrix(true, false);
                    const currentJ6 = new THREE.Vector3().setFromMatrixPosition(lastJointObj.matrixWorld);
                    j6Anchor!.position.copy(currentJ6);
                    const j6Quat = new THREE.Quaternion();
                    lastJointObj.getWorldQuaternion(j6Quat);
                    j6Anchor!.quaternion.copy(j6Quat);
                    j6Solver.resetDamping();
                }
            });

            j6Controls.addEventListener("change", () => {
                if (!j6Chain) return;
                const target = new THREE.Vector3();
                j6Anchor!.getWorldPosition(target);

                const targetOri = ikGizmoMode === "rotate" ? j6Anchor!.quaternion.clone() : undefined;

                const result = j6Solver.solve(
                    j6Chain,
                    target,
                    (name, angle) => {
                        robotArm.setJointAngleSilent(name, angle);
                    },
                    targetOri,
                );

                robotArm.notifyJointsChanged();

                if (result.singular || !result.reachable) {
                    // Solver already restored joint angles — snap gizmo back
                    lastJointObj.updateWorldMatrix(true, false);
                    j6Anchor!.position.setFromMatrixPosition(lastJointObj.matrixWorld);
                    const snapQuat = new THREE.Quaternion();
                    lastJointObj.getWorldQuaternion(snapQuat);
                    j6Anchor!.quaternion.copy(snapQuat);
                    ctx.view.update();
                    return;
                }

                // Sync TCP gizmo anchor after J6 IK
                const newTcp = robotArm.getTcpWorldPosition();
                if (newTcp) {
                    tcpAnchor.position.copy(newTcp);
                }
                if (chain) {
                    chain.tcpNode.updateWorldMatrix(true, false);
                    const tcpQuat = new THREE.Quaternion();
                    chain.tcpNode.getWorldQuaternion(tcpQuat);
                    tcpAnchor.quaternion.copy(tcpQuat);
                }

                PubSub.default.pub("robotJointsChanged" as any);
                ctx.view.update();
            });
        }
    }

    baseControls.addEventListener("dragging-changed", (event: any) => {
        setViewEnabled(!event.value);
    });
    tcpControls.addEventListener("dragging-changed", (event: any) => {
        setViewEnabled(!event.value);
        if (event.value) {
            const currentTcp = robotArm.getTcpWorldPosition();
            if (currentTcp) {
                tcpAnchor.position.copy(currentTcp);
            }
            if (chain) {
                chain.tcpNode.updateWorldMatrix(true, false);
                const tcpQuat = new THREE.Quaternion();
                chain.tcpNode.getWorldQuaternion(tcpQuat);
                tcpAnchor.quaternion.copy(tcpQuat);
            }
            solver.resetDamping();
        }
    });

    /** Computes world-space transform from base gizmo state */
    const getBaseTransform = (): THREE.Matrix4 => {
        const toOrigin = new THREE.Matrix4().makeTranslation(-basePos.x, -basePos.y, -basePos.z);
        const rotation = new THREE.Matrix4().makeRotationFromQuaternion(baseAnchor.quaternion);
        const fromOrigin = new THREE.Matrix4().makeTranslation(
            baseAnchor.position.x,
            baseAnchor.position.y,
            baseAnchor.position.z,
        );
        return new THREE.Matrix4().multiplyMatrices(fromOrigin, rotation).multiply(toOrigin);
    };

    // Base gizmo: ghost shadow follows the gizmo (robot stays still)
    baseControls.addEventListener("change", () => {
        ghostGroup.position.copy(baseAnchor.position);
        ghostGroup.quaternion.copy(baseAnchor.quaternion);
        ctx.view.update();
    });

    // TCP gizmo: run IK solver on every change
    tcpControls.addEventListener("change", () => {
        if (!chain) return;
        const target = new THREE.Vector3();
        tcpAnchor.getWorldPosition(target);

        const targetOri = ikGizmoMode === "rotate" ? tcpAnchor.quaternion.clone() : undefined;

        const result = solver.solve(
            chain,
            target,
            (name, angle) => {
                robotArm.setJointAngleSilent(name, angle);
            },
            targetOri,
        );

        robotArm.notifyJointsChanged();

        if (result.singular || !result.reachable) {
            // Solver already restored joint angles — snap gizmo back
            const currentTcp = robotArm.getTcpWorldPosition();
            if (currentTcp) {
                tcpAnchor.position.copy(currentTcp);
            }
            chain.tcpNode.updateWorldMatrix(true, false);
            const snapQuat = new THREE.Quaternion();
            chain.tcpNode.getWorldQuaternion(snapQuat);
            tcpAnchor.quaternion.copy(snapQuat);
            ctx.view.update();
            return;
        }

        // Sync J6 gizmo anchor after TCP IK
        if (j6Anchor && jointConfigs.length >= 2) {
            const lastJointObj = jointsMap.get(jointConfigs[jointConfigs.length - 1].name);
            if (lastJointObj) {
                lastJointObj.updateWorldMatrix(true, false);
                j6Anchor.position.setFromMatrixPosition(lastJointObj.matrixWorld);
                if (j6Controls?.getMode() === "rotate") {
                    const j6Quat = new THREE.Quaternion();
                    lastJointObj.getWorldQuaternion(j6Quat);
                    j6Anchor.quaternion.copy(j6Quat);
                }
            }
        }

        PubSub.default.pub("robotJointsChanged" as any);
        ctx.view.update();
    });

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            baseControls.detach();
            ctx.scene.remove(baseControls.getHelper());
            baseControls.dispose();
            ctx.scene.remove(baseAnchor);

            ctx.scene.remove(ghostGroup);
            ghostMaterial.dispose();

            tcpControls.detach();
            ctx.scene.remove(tcpControls.getHelper());
            tcpControls.dispose();
            ctx.scene.remove(tcpAnchor);

            if (j6Controls && j6Anchor) {
                j6Controls.detach();
                ctx.scene.remove(j6Controls.getHelper());
                j6Controls.dispose();
                ctx.scene.remove(j6Anchor);
            }

            setViewEnabled(true);
            document.removeEventListener("keydown", keyHandler, true);
            ctx.view.update();
        };

        const keyHandler = (event: KeyboardEvent) => {
            // T/R toggle gizmo mode for TCP and J6
            if (event.key === "t" || event.key === "T") {
                ikGizmoMode = "translate";
                tcpControls.setMode("translate");
                if (j6Controls) j6Controls.setMode("translate");
                ctx.view.update();
                return;
            }
            if (event.key === "r" || event.key === "R") {
                // Sync quaternions from current world state BEFORE switching mode,
                // so that the synchronous "change" events fired by setMode() don't
                // run 6-DOF IK with a stale quaternion.
                if (chain) {
                    chain.tcpNode.updateWorldMatrix(true, false);
                    const tcpQuat = new THREE.Quaternion();
                    chain.tcpNode.getWorldQuaternion(tcpQuat);
                    tcpAnchor.quaternion.copy(tcpQuat);
                }
                if (j6Anchor && jointConfigs.length >= 2) {
                    const lastJointObj = jointsMap.get(jointConfigs[jointConfigs.length - 1].name);
                    if (lastJointObj) {
                        lastJointObj.updateWorldMatrix(true, false);
                        const j6Quat = new THREE.Quaternion();
                        lastJointObj.getWorldQuaternion(j6Quat);
                        j6Anchor.quaternion.copy(j6Quat);
                    }
                }
                // setMode() fires synchronous "change" events — set ikGizmoMode
                // AFTER so those handlers still use 3-DOF solving (no orientation).
                tcpControls.setMode("rotate");
                if (j6Controls) j6Controls.setMode("rotate");
                ikGizmoMode = "rotate";
                ctx.view.update();
                return;
            }

            if (event.key === "Enter") {
                event.stopPropagation();
                event.preventDefault();

                const dx = baseAnchor.position.x - basePos.x;
                const dy = baseAnchor.position.y - basePos.y;
                const dz = baseAnchor.position.z - basePos.z;
                const rotAngle = baseAnchor.quaternion.angleTo(new THREE.Quaternion());

                if (
                    Math.abs(dx) > 0.001 ||
                    Math.abs(dy) > 0.001 ||
                    Math.abs(dz) > 0.001 ||
                    rotAngle > 0.001
                ) {
                    // Move the GLTF modelContainer to the new position.
                    // syncMeshNodeTransforms (via notifyJointsChanged) will then
                    // push the updated world matrices to Chili3D MeshNodes.
                    const transform = getBaseTransform();
                    modelContainer.applyMatrix4(transform);
                    modelContainer.updateMatrixWorld(true);
                    robotArm.notifyJointsChanged();

                    // Move gizmo anchors to follow the robot
                    const newTcp = robotArm.getTcpWorldPosition();
                    if (newTcp) {
                        tcpAnchor.position.copy(newTcp);
                    }
                    if (j6Anchor && jointConfigs.length >= 2) {
                        const lastJointObj = jointsMap.get(jointConfigs[jointConfigs.length - 1].name);
                        if (lastJointObj) {
                            lastJointObj.updateWorldMatrix(true, false);
                            j6Anchor.position.setFromMatrixPosition(lastJointObj.matrixWorld);
                        }
                    }
                }
                cleanup();
                resolve();
            } else if (event.key === "Escape") {
                event.stopPropagation();
                cleanup();
                reject(new Error("cancelled"));
            }
        };
        document.addEventListener("keydown", keyHandler, true);
    });
}

@command({
    key: "modify.move",
    icon: "icon-move",
})
export class RobotMoveCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const robotNodes = getSelectedRobotNodes(application);
        if (robotNodes && robotNodes.length > 0) {
            try {
                await createRobotDualGizmos(application, "translate");
            } catch {
                // User cancelled
            }
            return;
        }

        // Fall back to default move behavior for non-robot selections
        const doc = application.activeView?.document;
        if (!doc) return;

        const models = doc.selection.getSelectedNodes().filter((x) => x instanceof VisualNode);
        if (models.length === 0) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return;
        }

        const view = application.activeView;
        if (!view) return;

        const gizmo = view.createTransformGizmo?.(models);
        if (!gizmo) return;

        try {
            PubSub.default.pub("statusBarTip", "prompt.pickNextPoint");
            const transform = await gizmo.waitForResult();
            if (!transform.equals(Matrix4.identity())) {
                Transaction.execute(doc, "excute Move", () => {
                    models.forEach((x) => {
                        x.transform = x.transform.multiply(transform);
                    });
                    doc.visual.update();
                });
            }
        } catch {
            // cancelled
        } finally {
            gizmo.dispose();
        }
    }
}
