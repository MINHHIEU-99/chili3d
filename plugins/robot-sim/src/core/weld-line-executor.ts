// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as THREE from "three";
import { IKSolver } from "./ik-solver";
import type { WeldLineAction } from "./joint-config";
import type { RobotArm } from "./robot-arm";
import { extractKinematicChain, type KinematicChain } from "./robot-kinematics";

export interface TcpPose {
    x: number;
    y: number;
    z: number;
    w: number;
    p: number;
    r: number;
}

export interface WeldLogEntry {
    time: string;
    label: "Start" | "End";
    pose: TcpPose;
    flangePose?: TcpPose;
}

export interface WeldExecutionCallbacks {
    onProgress?: (progress: number) => void;
    onComplete?: () => void;
    onError?: (error: string) => void;
    onSceneUpdate?: () => void;
    onStateChange?: (state: "playing" | "paused" | "stopped" | "completed") => void;
    onLog?: (entry: WeldLogEntry) => void;
}

interface WeldWaypoint {
    /** Cumulative distance from the very first waypoint (0 at home) */
    cumulativeDistance: number;
    position: THREE.Vector3;
}

export type WeldPlaybackState = "idle" | "playing" | "paused" | "completed";

export class WeldLineExecutor {
    private state: WeldPlaybackState = "idle";
    private animationFrameId: number | null = null;

    // Pre-computed path
    private waypoints: WeldWaypoint[] = [];
    private totalDistance = 0;
    private speed = 0;
    /** Progress (0..1) at which TCP arrives at the weld line start point */
    private startPointProgress = 0;
    /** Progress (0..1) at which TCP arrives at the weld line end point */
    private endPointProgress = 0;

    // Playback
    /** Current progress 0..1 */
    private progress = 0;
    private lastFrameTime = 0;

    // Log tracking
    private loggedStart = false;
    private loggedEnd = false;

    // Dependencies
    private solver: IKSolver | null = null;
    private chain: KinematicChain | null = null;
    private robotArm: RobotArm | null = null;
    private callbacks: WeldExecutionCallbacks | null = null;

    /**
     * Prepares the weld trajectory but does NOT start playback.
     * Call `play()` afterwards to begin.
     */
    prepare(robotArm: RobotArm, action: WeldLineAction, callbacks?: WeldExecutionCallbacks): boolean {
        this.stop();

        const model = robotArm.getModel();
        const config = robotArm.getModelConfigRef();
        if (!model) {
            callbacks?.onError?.("No robot model loaded");
            return false;
        }

        const chain = extractKinematicChain(
            robotArm.getJointsMap(),
            robotArm.getJointConfigsRef(),
            model,
            config?.tcpNode,
        );
        if (!chain) {
            callbacks?.onError?.("Failed to build kinematic chain");
            return false;
        }

        const currentTcp = robotArm.getTcpWorldPosition();
        if (!currentTcp) {
            callbacks?.onError?.("Cannot determine current TCP position");
            return false;
        }

        const weld = action.weld;
        const homePos = currentTcp.clone();
        const startPos = new THREE.Vector3(...weld.start);
        const endPos = new THREE.Vector3(...weld.end);
        const stepsPerSegment = weld.steps ?? 50;

        // Build waypoints along all 3 segments: home→start, start→end, end→home
        this.waypoints = [];
        this.appendSegmentWaypoints(homePos, startPos, stepsPerSegment);
        const distAtStart = this.waypoints[this.waypoints.length - 1].cumulativeDistance;
        this.appendSegmentWaypoints(startPos, endPos, stepsPerSegment);
        const distAtEnd = this.waypoints[this.waypoints.length - 1].cumulativeDistance;
        this.appendSegmentWaypoints(endPos, homePos, stepsPerSegment);

        this.totalDistance = this.waypoints[this.waypoints.length - 1].cumulativeDistance;
        this.startPointProgress = this.totalDistance > 0 ? distAtStart / this.totalDistance : 0;
        this.endPointProgress = this.totalDistance > 0 ? distAtEnd / this.totalDistance : 0;
        this.speed = weld.speed;
        this.progress = 0;
        this.loggedStart = false;
        this.loggedEnd = false;

        this.solver = new IKSolver({
            maxIterations: 30,
            positionThreshold: 0.5,
            dampingFactor: 0.5,
            stepScale: 0.5,
        });
        this.chain = chain;
        this.robotArm = robotArm;
        this.callbacks = callbacks ?? null;

        this.state = "paused"; // Prepared but not playing
        callbacks?.onStateChange?.("paused");
        callbacks?.onProgress?.(0);
        return true;
    }

    play(): void {
        if (this.state === "playing") return;
        if (this.state !== "paused" && this.state !== "completed") return;

        if (this.state === "completed") {
            this.progress = 0;
            this.loggedStart = false;
            this.loggedEnd = false;
        }

        this.state = "playing";
        this.callbacks?.onStateChange?.("playing");
        this.lastFrameTime = performance.now();

        const trajectoryVisualizer = this.robotArm?.getTrajectoryVisualizer();
        if (this.progress === 0) {
            trajectoryVisualizer?.startNewTrajectory(`weld_${Date.now()}`);
        }

        this.scheduleFrame();
    }

    pause(): void {
        if (this.state !== "playing") return;
        this.cancelFrame();
        this.state = "paused";
        this.callbacks?.onStateChange?.("paused");
    }

    stop(): void {
        this.cancelFrame();
        this.state = "idle";
        this.progress = 0;
        this.waypoints = [];
        this.totalDistance = 0;
        this.solver = null;
        this.chain = null;
        this.robotArm = null;
        this.callbacks?.onStateChange?.("stopped");
        this.callbacks = null;
    }

    /**
     * Seek to a specific progress (0..1). Immediately solves IK for that position.
     * Can be called while paused or playing.
     */
    seekTo(progress: number): void {
        if (this.waypoints.length === 0 || !this.robotArm || !this.solver || !this.chain) return;
        this.progress = Math.max(0, Math.min(1, progress));
        this.applyCurrentProgress();
        this.callbacks?.onProgress?.(this.progress);
    }

    getState(): WeldPlaybackState {
        return this.state;
    }

    getProgress(): number {
        return this.progress;
    }

    isPrepared(): boolean {
        return this.waypoints.length > 0 && this.state !== "idle";
    }

    getSpeed(): number {
        return this.speed;
    }

    setSpeed(speed: number): void {
        this.speed = Math.max(1, speed);
    }

    /** Returns the pre-computed waypoint positions for trajectory preview */
    getWaypointPositions(): THREE.Vector3[] {
        return this.waypoints.map((wp) => wp.position.clone());
    }

    /** Returns progress values (0..1) for the weld start and end points */
    getMarkers(): { start: number; end: number } {
        return { start: this.startPointProgress, end: this.endPointProgress };
    }

    // -- internal --

    private appendSegmentWaypoints(from: THREE.Vector3, to: THREE.Vector3, steps: number): void {
        const count = Math.max(steps, 10);
        const baseDist =
            this.waypoints.length > 0 ? this.waypoints[this.waypoints.length - 1].cumulativeDistance : 0;
        const segLength = from.distanceTo(to);

        // Skip first point if we already have waypoints (avoid duplicate at segment boundary)
        const startI = this.waypoints.length > 0 ? 1 : 0;
        for (let i = startI; i <= count; i++) {
            const t = i / count;
            const pos = new THREE.Vector3().lerpVectors(from, to, t);
            this.waypoints.push({
                cumulativeDistance: baseDist + segLength * t,
                position: pos,
            });
        }
    }

    private scheduleFrame(): void {
        this.animationFrameId = requestAnimationFrame(() => this.tick());
    }

    private cancelFrame(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    private tick(): void {
        if (this.state !== "playing") return;

        const now = performance.now();
        const dt = (now - this.lastFrameTime) / 1000; // seconds
        this.lastFrameTime = now;

        // Advance progress based on speed and total distance
        if (this.totalDistance > 0) {
            const distanceDelta = this.speed * dt;
            this.progress += distanceDelta / this.totalDistance;
        }

        if (this.progress >= 1) {
            this.progress = 1;
            this.applyCurrentProgress();
            this.checkAndEmitLogs();
            this.callbacks?.onProgress?.(1);
            this.state = "completed";
            this.callbacks?.onStateChange?.("completed");
            this.callbacks?.onComplete?.();
            this.robotArm?.getTrajectoryVisualizer()?.finishTrajectory();
            return;
        }

        this.applyCurrentProgress();
        this.checkAndEmitLogs();
        this.callbacks?.onProgress?.(this.progress);
        this.callbacks?.onSceneUpdate?.();

        this.scheduleFrame();
    }

    private applyCurrentProgress(): void {
        if (!this.robotArm || !this.solver || !this.chain || this.waypoints.length === 0) return;

        const targetDist = this.progress * this.totalDistance;
        const pos = this.interpolatePosition(targetDist);

        this.solver.solve(this.chain, pos, (name, angle) => {
            this.robotArm!.setJointAngleSilent(name, angle);
        });
        this.robotArm.notifyJointsChanged();

        // Record trajectory point
        const tcpPos = this.robotArm.getTcpWorldPosition();
        if (tcpPos && this.state === "playing") {
            this.robotArm.getTrajectoryVisualizer()?.addTrajectoryPoint({
                position: tcpPos.clone(),
                time: performance.now(),
                frameId: Math.round(this.progress * 1000),
            });
        }
    }

    private checkAndEmitLogs(): void {
        if (!this.robotArm || !this.callbacks?.onLog) return;

        if (!this.loggedStart && this.progress >= this.startPointProgress) {
            this.loggedStart = true;
            const pose = this.robotArm.getTcpWorldPose();
            const flangePose = this.robotArm.getJ6WorldPose();
            if (pose) {
                this.callbacks.onLog({
                    time: new Date().toISOString(),
                    label: "Start",
                    pose,
                    flangePose: flangePose ?? undefined,
                });
            }
        }

        if (!this.loggedEnd && this.progress >= this.endPointProgress) {
            this.loggedEnd = true;
            const pose = this.robotArm.getTcpWorldPose();
            const flangePose = this.robotArm.getJ6WorldPose();
            if (pose) {
                this.callbacks.onLog({
                    time: new Date().toISOString(),
                    label: "End",
                    pose,
                    flangePose: flangePose ?? undefined,
                });
            }
        }
    }

    private interpolatePosition(distance: number): THREE.Vector3 {
        const wp = this.waypoints;
        if (distance <= 0) return wp[0].position.clone();
        if (distance >= this.totalDistance) return wp[wp.length - 1].position.clone();

        // Binary search for the segment
        let lo = 0;
        let hi = wp.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (wp[mid].cumulativeDistance <= distance) lo = mid;
            else hi = mid;
        }

        const a = wp[lo];
        const b = wp[hi];
        const segLen = b.cumulativeDistance - a.cumulativeDistance;
        const t = segLen > 0 ? (distance - a.cumulativeDistance) / segLen : 0;
        return new THREE.Vector3().lerpVectors(a.position, b.position, t);
    }
}

export function validateWeldLineAction(json: unknown): json is WeldLineAction {
    if (typeof json !== "object" || json === null) return false;
    const obj = json as Record<string, unknown>;

    if (typeof obj.meta !== "object" || obj.meta === null) return false;
    const meta = obj.meta as Record<string, unknown>;
    if (meta.action_type !== "weld_line") return false;

    if (typeof obj.weld !== "object" || obj.weld === null) return false;
    const weld = obj.weld as Record<string, unknown>;

    if (!Array.isArray(weld.start) || weld.start.length !== 3) return false;
    if (!Array.isArray(weld.end) || weld.end.length !== 3) return false;
    if (typeof weld.speed !== "number" || weld.speed <= 0) return false;

    if (!weld.start.every((v: unknown) => typeof v === "number")) return false;
    if (!weld.end.every((v: unknown) => typeof v === "number")) return false;

    return true;
}
