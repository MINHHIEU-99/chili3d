// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as THREE from "three";
import type { JointConfig } from "./joint-config";

export interface KinematicJoint {
    object3D: THREE.Object3D;
    config: JointConfig;
    worldPosition: THREE.Vector3;
    worldAxis: THREE.Vector3;
}

export interface KinematicChain {
    joints: KinematicJoint[];
    tcpNode: THREE.Object3D;
}

const _localAxis = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _tcpPos = new THREE.Vector3();
const _diff = new THREE.Vector3();
const _cross = new THREE.Vector3();

const AXIS_MAP: Record<string, THREE.Vector3> = {
    X: new THREE.Vector3(1, 0, 0),
    Y: new THREE.Vector3(0, 1, 0),
    Z: new THREE.Vector3(0, 0, 1),
};

/**
 * Extracts a kinematic chain from the Three.js scene graph.
 * Joints are ordered as they appear in jointConfigs (base to tip).
 */
export function extractKinematicChain(
    jointsMap: Map<string, THREE.Object3D>,
    jointConfigs: JointConfig[],
    model: THREE.Group,
    tcpNodeName?: string,
): KinematicChain | null {
    const joints: KinematicJoint[] = [];

    for (const config of jointConfigs) {
        const obj = jointsMap.get(config.name);
        if (!obj) continue;
        joints.push({
            object3D: obj,
            config,
            worldPosition: new THREE.Vector3(),
            worldAxis: new THREE.Vector3(),
        });
    }

    if (joints.length === 0) return null;

    // Find TCP node
    let tcpNode: THREE.Object3D | null = null;
    const searchNames = tcpNodeName ? [tcpNodeName, "TCP", "gripper_base"] : ["TCP", "gripper_base"];
    for (const name of searchNames) {
        model.traverse((child) => {
            if (!tcpNode && child.name === name) {
                tcpNode = child;
            }
        });
        if (tcpNode) break;
    }

    // Fallback: use the last joint's first child or the joint itself
    if (!tcpNode) {
        const lastJoint = joints[joints.length - 1].object3D;
        tcpNode = lastJoint.children[0] ?? lastJoint;
    }

    return { joints, tcpNode };
}

/**
 * Updates world positions and axes for all joints in the chain.
 * Must be called after modifying joint angles and before computing the Jacobian.
 */
export function updateChainWorldState(chain: KinematicChain): void {
    chain.tcpNode.updateWorldMatrix(true, false);

    for (const joint of chain.joints) {
        joint.object3D.getWorldPosition(joint.worldPosition);
        // Compute world axis: transform local axis by joint's world rotation
        const localDir = AXIS_MAP[joint.config.axis];
        if (!localDir) continue;
        _localAxis.copy(localDir);
        joint.object3D.getWorldQuaternion(_worldQuat);
        joint.worldAxis.copy(_localAxis).applyQuaternion(_worldQuat).normalize();
    }
}

/**
 * Computes the 3xN Jacobian matrix (position-only) for the kinematic chain.
 * Returns a Float64Array in row-major order: [row0_col0, row0_col1, ..., row2_colN-1].
 *
 * For rotational joints: column = worldAxis × (tcpPos - jointPos)
 * For linear joints: column = worldAxis
 */
export function computeJacobian(chain: KinematicChain): Float64Array {
    const n = chain.joints.length;
    const J = new Float64Array(3 * n);

    chain.tcpNode.getWorldPosition(_tcpPos);

    for (let i = 0; i < n; i++) {
        const joint = chain.joints[i];

        if (joint.config.type === "rotational") {
            _diff.subVectors(_tcpPos, joint.worldPosition);
            _cross.crossVectors(joint.worldAxis, _diff);
            // Column i: row-major layout [row][col] = J[row * n + col]
            J[0 * n + i] = _cross.x;
            J[1 * n + i] = _cross.y;
            J[2 * n + i] = _cross.z;
        } else {
            // Linear joint: column = world axis direction
            J[0 * n + i] = joint.worldAxis.x;
            J[1 * n + i] = joint.worldAxis.y;
            J[2 * n + i] = joint.worldAxis.z;
        }
    }

    return J;
}

/**
 * Computes the manipulability measure: sqrt(det(J * J^T)).
 * A value near zero indicates the robot is at or near a singularity,
 * meaning it has lost one or more degrees of freedom.
 */
export function computeManipulability(chain: KinematicChain): number {
    const n = chain.joints.length;
    const J = computeJacobian(chain);

    // Compute J * J^T (3x3)
    const JJT = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = r; c < 3; c++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += J[r * n + k] * J[c * n + k];
            }
            JJT[r * 3 + c] = sum;
            JJT[c * 3 + r] = sum;
        }
    }

    // Determinant of 3x3
    const [a, b, c, d, e, f, g, h, i] = JJT;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);

    return Math.sqrt(Math.max(0, det));
}
