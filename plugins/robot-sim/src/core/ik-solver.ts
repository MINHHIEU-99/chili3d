// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as THREE from "three";
import type { KinematicChain } from "./robot-kinematics";
import { computeJacobian, computeManipulability, updateChainWorldState } from "./robot-kinematics";

export interface IKSolverConfig {
    maxIterations: number;
    /** Position error threshold in world units */
    positionThreshold: number;
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
     * Runs the IK solver to move the TCP toward the target position.
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
     */
    solve(
        chain: KinematicChain,
        targetPosition: THREE.Vector3,
        applyJointAngle: (name: string, angle: number) => void,
    ): IKResult {
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
