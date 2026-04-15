// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as THREE from "three";
import type { KinematicChain } from "./robot-kinematics";
import {
    computeFullJacobian,
    computeJacobian,
    computeManipulability,
    updateChainWorldState,
} from "./robot-kinematics";

export interface IKSolverConfig {
    maxIterations: number;
    /** Position error threshold in world units */
    positionThreshold: number;
    /** Orientation error threshold in radians */
    orientationThreshold: number;
    /** Weight applied to orientation error to balance it against position error */
    orientationWeight: number;
    /** Initial damping factor (lambda) */
    dampingFactor: number;
    /** Scales delta_q per iteration to prevent overshooting */
    stepScale: number;
    /** Manipulability threshold below which the configuration is considered singular */
    singularityThreshold: number;
}

export interface IKResult {
    converged: boolean;
    iterations: number;
    finalError: number;
    /** True when the robot is at or near a kinematic singularity */
    singular: boolean;
    /** True when the target is within the reachable workspace */
    reachable: boolean;
}

const DEFAULT_CONFIG: IKSolverConfig = {
    maxIterations: 20,
    positionThreshold: 0.5,
    orientationThreshold: 0.02,
    orientationWeight: 50,
    dampingFactor: 0.5,
    stepScale: 0.5,
    singularityThreshold: 10,
};

const _tcpPos = new THREE.Vector3();
const _error = new THREE.Vector3();

/**
 * Damped Least Squares (Levenberg-Marquardt) IK solver.
 *
 * Solves: delta_q = J^T * (J * J^T + lambda^2 * I)^(-1) * e
 *
 * Operates entirely in Three.js world space. Joint angle updates are
 * converted to local units (degrees for rotational, mm for linear).
 */
export class IKSolver {
    private config: IKSolverConfig;
    private lambda: number;

    constructor(config?: Partial<IKSolverConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.lambda = this.config.dampingFactor;
    }

    /**
     * Runs the IK solver to move the TCP toward the target position,
     * and optionally toward a target orientation.
     *
     * The solver works in two phases:
     * 1. Compute tentative joint angles (applying them to compute forward kinematics)
     * 2. Only commit the result if valid (converged, not singular, reachable)
     *    — otherwise restore the original joint angles so the robot stays put.
     *
     * @param chain - The kinematic chain (joints + TCP node)
     * @param targetPosition - Desired TCP position in world space
     * @param applyJointAngle - Callback to apply a joint angle (name, angleDegOrMm)
     *                          Should call setJointAngleSilent() to avoid per-joint scene updates
     * @param targetOrientation - Optional desired TCP orientation in world space
     */
    solve(
        chain: KinematicChain,
        targetPosition: THREE.Vector3,
        applyJointAngle: (name: string, angle: number) => void,
        targetOrientation?: THREE.Quaternion,
    ): IKResult {
        if (targetOrientation) {
            return this.solve6DOF(chain, targetPosition, targetOrientation, applyJointAngle);
        }
        const { maxIterations, positionThreshold, stepScale, singularityThreshold } = this.config;
        let prevError = Infinity;
        this.lambda = this.config.dampingFactor;

        // Save original joint angles so we can restore on failure
        const n = chain.joints.length;
        const savedAngles = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            savedAngles[i] = chain.joints[i].config.currentAngle;
        }

        let hitSingularity = false;

        for (let iter = 0; iter < maxIterations; iter++) {
            // Update world matrices and joint state
            updateChainWorldState(chain);
            chain.tcpNode.getWorldPosition(_tcpPos);

            // Compute position error
            _error.subVectors(targetPosition, _tcpPos);
            const errorMag = _error.length();

            if (errorMag < positionThreshold) {
                return {
                    converged: true,
                    iterations: iter,
                    finalError: errorMag,
                    singular: false,
                    reachable: true,
                };
            }

            // Check for singularity before computing joint updates
            const manipulability = computeManipulability(chain);
            if (manipulability < singularityThreshold) {
                hitSingularity = true;
                break;
            }

            // Adaptive damping
            if (errorMag > prevError) {
                this.lambda = Math.min(this.lambda * 2, 10);
            } else {
                this.lambda = Math.max(this.lambda * 0.5, 0.01);
            }
            prevError = errorMag;

            // Compute Jacobian (3xN)
            const J = computeJacobian(chain);

            // Compute JJT = J * J^T (3x3) + lambda^2 * I
            const JJT = computeJJT(J, n, this.lambda);

            // Invert JJT (3x3)
            const JJTinv = invert3x3(JJT);
            if (!JJTinv) continue; // Singular — skip this iteration

            // Compute JJTinv * e (3x1)
            const ex = _error.x,
                ey = _error.y,
                ez = _error.z;
            const vx = JJTinv[0] * ex + JJTinv[1] * ey + JJTinv[2] * ez;
            const vy = JJTinv[3] * ex + JJTinv[4] * ey + JJTinv[5] * ez;
            const vz = JJTinv[6] * ex + JJTinv[7] * ey + JJTinv[8] * ez;

            // Compute delta_q = J^T * v (Nx1)
            for (let i = 0; i < n; i++) {
                const dq = (J[0 * n + i] * vx + J[1 * n + i] * vy + J[2 * n + i] * vz) * stepScale;

                const joint = chain.joints[i];
                const config = joint.config;
                const dir = config.direction ?? 1;
                let newAngle: number;

                if (config.type === "rotational") {
                    newAngle = config.currentAngle + dir * THREE.MathUtils.radToDeg(dq);
                } else {
                    // Linear: world-space displacement maps 1:1 to config units (mm)
                    newAngle = config.currentAngle + dir * dq;
                }

                // Clamp to joint limits
                newAngle = Math.max(config.minAngle, Math.min(config.maxAngle, newAngle));
                applyJointAngle(config.name, newAngle);
            }
        }

        // Evaluate final state
        updateChainWorldState(chain);
        chain.tcpNode.getWorldPosition(_tcpPos);
        const finalError = _tcpPos.distanceTo(targetPosition);

        // Determine if the target is reachable: converged or error is acceptably small
        const reachable = !hitSingularity && finalError < positionThreshold * 10;

        if (hitSingularity || !reachable) {
            // Restore original joint angles — robot stays stationary
            for (let i = 0; i < n; i++) {
                applyJointAngle(chain.joints[i].config.name, savedAngles[i]);
            }
        }

        return {
            converged: false,
            iterations: maxIterations,
            finalError,
            singular: hitSingularity,
            reachable,
        };
    }

    /**
     * 6-DOF IK solver: solves for both position and orientation.
     * Uses a 6×N Jacobian with damped least squares.
     */
    private solve6DOF(
        chain: KinematicChain,
        targetPosition: THREE.Vector3,
        targetOrientation: THREE.Quaternion,
        applyJointAngle: (name: string, angle: number) => void,
    ): IKResult {
        const {
            maxIterations,
            positionThreshold,
            orientationThreshold,
            orientationWeight,
            stepScale,
            singularityThreshold,
        } = this.config;
        let prevError = Infinity;
        this.lambda = this.config.dampingFactor;

        const n = chain.joints.length;
        const savedAngles = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            savedAngles[i] = chain.joints[i].config.currentAngle;
        }

        let hitSingularity = false;
        const currentQuat = new THREE.Quaternion();
        const errorQuat = new THREE.Quaternion();

        for (let iter = 0; iter < maxIterations; iter++) {
            updateChainWorldState(chain);
            chain.tcpNode.getWorldPosition(_tcpPos);
            chain.tcpNode.getWorldQuaternion(currentQuat);

            // Position error
            _error.subVectors(targetPosition, _tcpPos);
            const posError = _error.length();

            // Orientation error: rotation vector representation
            errorQuat.copy(targetOrientation).multiply(currentQuat.conjugate());
            if (errorQuat.w < 0) {
                errorQuat.x = -errorQuat.x;
                errorQuat.y = -errorQuat.y;
                errorQuat.z = -errorQuat.z;
                errorQuat.w = -errorQuat.w;
            }
            const halfAngle = Math.acos(Math.min(1, errorQuat.w));
            const sinHalf = Math.sin(halfAngle);
            let oriX = 0,
                oriY = 0,
                oriZ = 0;
            if (sinHalf > 1e-6) {
                const angle = 2 * halfAngle;
                const s = angle / sinHalf;
                oriX = errorQuat.x * s;
                oriY = errorQuat.y * s;
                oriZ = errorQuat.z * s;
            }
            const oriError = Math.sqrt(oriX * oriX + oriY * oriY + oriZ * oriZ);

            if (posError < positionThreshold && oriError < orientationThreshold) {
                return {
                    converged: true,
                    iterations: iter,
                    finalError: posError,
                    singular: false,
                    reachable: true,
                };
            }

            const manipulability = computeManipulability(chain);
            if (manipulability < singularityThreshold) {
                hitSingularity = true;
                break;
            }

            // Build 6D error vector (weighted orientation)
            const e = [
                _error.x,
                _error.y,
                _error.z,
                oriX * orientationWeight,
                oriY * orientationWeight,
                oriZ * orientationWeight,
            ];

            const totalError = Math.sqrt(
                e[0] * e[0] + e[1] * e[1] + e[2] * e[2] + e[3] * e[3] + e[4] * e[4] + e[5] * e[5],
            );

            // Adaptive damping
            if (totalError > prevError) {
                this.lambda = Math.min(this.lambda * 2, 10);
            } else {
                this.lambda = Math.max(this.lambda * 0.5, 0.01);
            }
            prevError = totalError;

            // 6×N Jacobian (apply orientation weight to rows 3-5)
            const J = computeFullJacobian(chain);
            for (let i = 0; i < n; i++) {
                J[3 * n + i] *= orientationWeight;
                J[4 * n + i] *= orientationWeight;
                J[5 * n + i] *= orientationWeight;
            }

            // JJT (6×6) + lambda^2 * I
            const JJT = computeJJTNxN(J, 6, n, this.lambda);
            const JJTinv = invertNxN(JJT, 6);
            if (!JJTinv) continue;

            // v = JJTinv * e (6×1)
            const v = new Float64Array(6);
            for (let r = 0; r < 6; r++) {
                let sum = 0;
                for (let c = 0; c < 6; c++) {
                    sum += JJTinv[r * 6 + c] * e[c];
                }
                v[r] = sum;
            }

            // delta_q = J^T * v (N×1)
            for (let i = 0; i < n; i++) {
                let dq = 0;
                for (let r = 0; r < 6; r++) {
                    dq += J[r * n + i] * v[r];
                }
                dq *= stepScale;

                const joint = chain.joints[i];
                const config = joint.config;
                const dir = config.direction ?? 1;
                let newAngle: number;

                if (config.type === "rotational") {
                    newAngle = config.currentAngle + dir * THREE.MathUtils.radToDeg(dq);
                } else {
                    newAngle = config.currentAngle + dir * dq;
                }

                newAngle = Math.max(config.minAngle, Math.min(config.maxAngle, newAngle));
                applyJointAngle(config.name, newAngle);
            }
        }

        // Evaluate final state
        updateChainWorldState(chain);
        chain.tcpNode.getWorldPosition(_tcpPos);
        const finalError = _tcpPos.distanceTo(targetPosition);
        const reachable = !hitSingularity && finalError < positionThreshold * 10;

        if (hitSingularity || !reachable) {
            for (let i = 0; i < n; i++) {
                applyJointAngle(chain.joints[i].config.name, savedAngles[i]);
            }
        }

        return {
            converged: false,
            iterations: maxIterations,
            finalError,
            singular: hitSingularity,
            reachable,
        };
    }

    resetDamping(): void {
        this.lambda = this.config.dampingFactor;
    }
}

/** Compute J * J^T (3x3) and add lambda^2 to diagonal */
function computeJJT(J: Float64Array, n: number, lambda: number): Float64Array {
    const JJT = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = r; c < 3; c++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += J[r * n + k] * J[c * n + k];
            }
            JJT[r * 3 + c] = sum;
            JJT[c * 3 + r] = sum; // Symmetric
        }
    }
    // Add damping
    const l2 = lambda * lambda;
    JJT[0] += l2;
    JJT[4] += l2;
    JJT[8] += l2;
    return JJT;
}

/** Invert a 3x3 matrix using the adjugate/determinant formula. Returns null if singular. */
function invert3x3(m: Float64Array): Float64Array | null {
    const [a, b, c, d, e, f, g, h, i] = m;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return null;

    const invDet = 1 / det;
    return new Float64Array([
        (e * i - f * h) * invDet,
        (c * h - b * i) * invDet,
        (b * f - c * e) * invDet,
        (f * g - d * i) * invDet,
        (a * i - c * g) * invDet,
        (c * d - a * f) * invDet,
        (d * h - e * g) * invDet,
        (b * g - a * h) * invDet,
        (a * e - b * d) * invDet,
    ]);
}

/** Compute J * J^T (m×m) and add lambda^2 to diagonal. General version for any m. */
function computeJJTNxN(J: Float64Array, m: number, n: number, lambda: number): Float64Array {
    const JJT = new Float64Array(m * m);
    for (let r = 0; r < m; r++) {
        for (let c = r; c < m; c++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += J[r * n + k] * J[c * n + k];
            }
            JJT[r * m + c] = sum;
            JJT[c * m + r] = sum;
        }
    }
    const l2 = lambda * lambda;
    for (let i = 0; i < m; i++) {
        JJT[i * m + i] += l2;
    }
    return JJT;
}

/** Invert an N×N matrix using Gauss-Jordan elimination with partial pivoting. Returns null if singular. */
function invertNxN(mat: Float64Array, n: number): Float64Array | null {
    const w = 2 * n;
    const aug = new Float64Array(n * w);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            aug[i * w + j] = mat[i * n + j];
        }
        aug[i * w + n + i] = 1;
    }

    for (let col = 0; col < n; col++) {
        let maxVal = Math.abs(aug[col * w + col]);
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
            const val = Math.abs(aug[row * w + col]);
            if (val > maxVal) {
                maxVal = val;
                maxRow = row;
            }
        }
        if (maxVal < 1e-12) return null;

        if (maxRow !== col) {
            for (let j = 0; j < w; j++) {
                const tmp = aug[col * w + j];
                aug[col * w + j] = aug[maxRow * w + j];
                aug[maxRow * w + j] = tmp;
            }
        }

        const pivot = aug[col * w + col];
        for (let j = 0; j < w; j++) {
            aug[col * w + j] /= pivot;
        }

        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = aug[row * w + col];
            for (let j = 0; j < w; j++) {
                aug[row * w + j] -= factor * aug[col * w + j];
            }
        }
    }

    const inv = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            inv[i * n + j] = aug[i * w + n + j];
        }
    }
    return inv;
}
