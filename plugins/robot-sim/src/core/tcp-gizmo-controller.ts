// // Part of the Chili3d Project, under the AGPL-3.0 License.
// // See LICENSE file in the project root for full license information.

// import * as THREE from "three";
// import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
// import { IKSolver } from "./ik-solver";
// import type { RobotArm } from "./robot-arm";
// import { extractKinematicChain, type KinematicChain } from "./robot-kinematics";

// /**
//  * Manages a TransformControls gizmo attached to the robot TCP.
//  * Dragging the gizmo fires the IK solver to move the robot in real-time.
//  */
// export class TcpGizmoController {
//     private controls: TransformControls | null = null;
//     private anchor: THREE.Object3D | null = null;
//     private chain: KinematicChain | null = null;
//     private solver = new IKSolver();
//     private active = false;

//     private onDraggingChanged: ((event: any) => void) | null = null;
//     private onChange: (() => void) | null = null;
//     private onKeyDown: ((event: KeyboardEvent) => void) | null = null;

//     constructor(
//         private robotArm: RobotArm,
//         private camera: () => THREE.Camera,
//         private domElement: HTMLElement,
//         private setViewHandlerEnabled: (enabled: boolean) => void,
//         private onUpdate: () => void,
//     ) {}

//     activate(): void {
//         if (this.active) return;

//         const model = this.robotArm.getModel();
//         if (!model) return;

//         const config = this.robotArm.getModelConfigRef();
//         this.chain = extractKinematicChain(
//             this.robotArm.getJointsMap(),
//             this.robotArm.getJointConfigsRef(),
//             model,
//             config?.tcpNode,
//         );
//         if (!this.chain) return;

//         const scene = this.robotArm.getScene();
//         const tcpPos = this.robotArm.getTcpWorldPosition();
//         if (!tcpPos) return;

//         // Create anchor at current TCP world position
//         this.anchor = new THREE.Object3D();
//         this.anchor.position.copy(tcpPos);
//         scene.add(this.anchor);

//         // Create TransformControls (translate-only)
//         this.controls = new TransformControls(this.camera(), this.domElement);
//         this.controls.setMode("translate");
//         this.controls.setSize(0.8);
//         this.controls.attach(this.anchor);
//         scene.add(this.controls.getHelper());

//         // Disable camera orbit during drag
//         this.onDraggingChanged = (event: any) => {
//             this.setViewHandlerEnabled(!event.value);
//             // On drag start, snap anchor to actual TCP position to prevent drift
//             if (event.value && this.anchor) {
//                 const currentTcp = this.robotArm.getTcpWorldPosition();
//                 if (currentTcp) {
//                     this.anchor.position.copy(currentTcp);
//                 }
//                 this.solver.resetDamping();
//             }
//         };
//         this.controls.addEventListener("dragging-changed", this.onDraggingChanged);

//         // Run IK on every gizmo change
//         this.onChange = () => {
//             if (!this.chain || !this.anchor) return;
//             const target = new THREE.Vector3();
//             this.anchor.getWorldPosition(target);

//             this.solver.solve(this.chain, target, (name, angle) => {
//                 this.robotArm.setJointAngleSilent(name, angle);
//             });

//             this.robotArm.notifyJointsChanged();
//             this.onUpdate();
//         };
//         this.controls.addEventListener("change", this.onChange);

//         // Escape to deactivate
//         this.onKeyDown = (event: KeyboardEvent) => {
//             if (event.key === "Escape") {
//                 this.deactivate();
//             }
//         };
//         document.addEventListener("keydown", this.onKeyDown);

//         this.active = true;
//     }

//     deactivate(): void {
//         if (!this.active) return;

//         const scene = this.robotArm.getScene();

//         if (this.controls) {
//             if (this.onDraggingChanged) {
//                 this.controls.removeEventListener("dragging-changed", this.onDraggingChanged);
//             }
//             if (this.onChange) {
//                 this.controls.removeEventListener("change", this.onChange);
//             }
//             this.controls.detach();
//             scene.remove(this.controls.getHelper());
//             this.controls.dispose();
//             this.controls = null;
//         }

//         if (this.anchor) {
//             scene.remove(this.anchor);
//             this.anchor = null;
//         }

//         if (this.onKeyDown) {
//             document.removeEventListener("keydown", this.onKeyDown);
//             this.onKeyDown = null;
//         }

//         this.setViewHandlerEnabled(true);
//         this.chain = null;
//         this.active = false;
//         this.onUpdate();
//     }

//     isGizmoActive(): boolean {
//         return this.active;
//     }

//     dispose(): void {
//         this.deactivate();
//     }
// }
