// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { RobotArm } from "./robot-arm";

export interface FrameData {
    id: number;
    time: number;
    joints: number[];
    cartesian?: {
        position: [number, number, number];
        orientation: [number, number, number, number];
    } | null;
    io?: {
        digital_output_0?: boolean;
    };
}

export interface PlayCallbackOptions {
    onFrameUpdate?: (frame: FrameData) => void;
    onFrameComplete?: (frame: FrameData) => void;
    onError?: (frame: FrameData, error?: any) => void;
}

type PlayStatus = "idle" | "playing" | "stopped";

export class JointAnimationQueue {
    private robotArm: RobotArm | null = null;
    private frameQueue: FrameData[] = [];
    private status: PlayStatus = "idle";
    private playCallbackOptions: PlayCallbackOptions = {};
    private isProcessing = false;
    private animationLoopId: number | null = null;
    private lastProcessedFrame: FrameData | null = null;

    setRobotArm(robotArm: RobotArm): void {
        this.robotArm = robotArm;
    }

    startSequence(options: PlayCallbackOptions = {}): void {
        this.status = "playing";
        this.playCallbackOptions = options;
        this.frameQueue = [];
        this.lastProcessedFrame = null;
        this.isProcessing = false;
        this.startAnimationLoop();
    }

    enqueueFrame(frame: FrameData): void {
        this.frameQueue.push(frame);
    }

    private startAnimationLoop(): void {
        if (this.animationLoopId !== null) return;
        const loop = () => {
            if (this.status === "playing" && !this.isProcessing) {
                this.processQueue();
            }
            this.animationLoopId = requestAnimationFrame(loop);
        };
        this.animationLoopId = requestAnimationFrame(loop);
    }

    private stopAnimationLoop(): void {
        if (this.animationLoopId !== null) {
            cancelAnimationFrame(this.animationLoopId);
            this.animationLoopId = null;
        }
    }

    private processQueue(): void {
        if (this.isProcessing || !this.robotArm) return;
        if (this.frameQueue.length > 0) {
            this.isProcessing = true;
            const currentFrame = this.frameQueue.shift()!;
            const nextFrame = this.frameQueue[0];
            this.executeFrame(currentFrame, nextFrame);
        }
    }

    private executeFrame(frame: FrameData, nextFrame?: FrameData): void {
        if (!this.robotArm) {
            this.isProcessing = false;
            return;
        }
        try {
            const duration = this.calculateFrameDuration(frame, nextFrame);
            const jointConfigs = this.robotArm.getJointConfigs();
            const jointAngles: Record<string, number> = {};

            frame.joints.forEach((value, index) => {
                if (index < jointConfigs.length) {
                    const config = jointConfigs[index];
                    jointAngles[config.name] = config.type === "linear" ? value : (value * 180) / Math.PI;
                }
            });

            let gripperOpenness: number | undefined;
            if (frame.io?.digital_output_0 !== undefined) {
                gripperOpenness = frame.io.digital_output_0 ? 0 : 1;
            }

            this.robotArm.animateMultipleJoints(jointAngles, duration, {
                onStart: () => {
                    this.playCallbackOptions.onFrameUpdate?.(frame);
                },
                onComplete: () => {
                    this.isProcessing = false;
                    this.lastProcessedFrame = frame;
                    this.playCallbackOptions.onFrameComplete?.(frame);
                },
            });

            if (gripperOpenness !== undefined) {
                this.robotArm.animateGripperOpenness(gripperOpenness);
            }
        } catch (error) {
            this.isProcessing = false;
            this.playCallbackOptions.onError?.(frame, error);
            this.stop();
        }
    }

    private calculateFrameDuration(currentFrame: FrameData, nextFrame?: FrameData): number {
        if (!this.lastProcessedFrame) return 1.0;
        if (nextFrame) {
            return Math.max(0.1, (nextFrame.time - currentFrame.time) / 1000);
        }
        return Math.max(0.1, (currentFrame.time - this.lastProcessedFrame.time) / 1000);
    }

    stop(): void {
        if (this.status === "idle") return;
        this.status = "stopped";
        this.isProcessing = false;
        if (this.robotArm) {
            this.robotArm.stopAnimation();
            this.robotArm.stopAllJointAnimations();
        }
        this.stopAnimationLoop();
        this.frameQueue = [];
    }

    getStatus(): PlayStatus {
        return this.status;
    }
}
