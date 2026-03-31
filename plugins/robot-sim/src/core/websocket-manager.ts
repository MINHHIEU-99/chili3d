// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FrameData, JointAnimationQueue } from "./joint-animation-queue";
import type { JointConfig } from "./joint-config";
import type { RobotArm } from "./robot-arm";
import { TrajectoryVisualizer } from "./trajectory-visualizer";
import { type JointControlData, type RobotStateData, WebSocketClient } from "./websocket-client";

export interface WebSocketConfig {
    url: string;
    clientName: string;
    enableStateSync: boolean;
    stateSyncInterval: number;
}

export class WebSocketManager {
    private client: WebSocketClient | null = null;
    private robotArm: RobotArm | null = null;
    private config: WebSocketConfig;
    private stateSyncInterval: number | null = null;
    private isStateSyncEnabled = false;
    private animationQueue = new JointAnimationQueue();

    private onConnectionStatusCallback?: (connected: boolean) => void;
    private onRemoteCommandCallback?: (command: string, data: any) => void;
    private onSequenceCallback?: (event: string, data: any) => void;
    private onJointUpdateCallback?: () => void;

    constructor(config: WebSocketConfig) {
        this.config = { ...config };
    }

    async initialize(robotArm: RobotArm): Promise<void> {
        this.robotArm = robotArm;
        this.animationQueue.setRobotArm(robotArm);

        this.client = new WebSocketClient(this.config.url, {
            id: 0,
            type: "simulator",
            name: this.config.clientName,
        });

        this.setupEventHandlers();
    }

    async connect(): Promise<void> {
        if (!this.client) throw new Error("WebSocket client not initialized");
        await this.client.connect();
        if (this.config.enableStateSync) this.startStateSync();
    }

    disconnect(): void {
        this.stopStateSync();
        this.client?.disconnect();
    }

    private setupEventHandlers(): void {
        if (!this.client) return;

        this.client.on("connected", () => this.onConnectionStatusCallback?.(true));
        this.client.on("disconnected", () => {
            this.onConnectionStatusCallback?.(false);
            this.stopStateSync();
        });

        this.client.on("joint_control_command", (data) => this.handleJointControlCommand(data));

        this.client.on("reset_robot", (data) => {
            this.robotArm?.resetToDefault();
            this.onRemoteCommandCallback?.("reset_robot", data);
            this.onJointUpdateCallback?.();
        });

        this.client.on("emergency_stop", () => {
            this.robotArm?.stopAnimation();
            this.robotArm?.stopAllJointAnimations();
            this.animationQueue.stop();
            this.onRemoteCommandCallback?.("emergency_stop", {});
            this.onJointUpdateCallback?.();
        });

        this.client.on("clients_list", (data) => {
            console.log("Clients:", data.clients);
        });

        this.client.on("sequence_start", (data) => this.handleSequenceStart(data));
        this.client.on("sequence_frame", (data) => this.animationQueue.enqueueFrame(data));
        this.client.on("sequence_complete", (data) => this.onSequenceCallback?.("complete", data));
        this.client.on("sequence_stopped", () => {
            this.animationQueue.stop();
            this.onSequenceCallback?.("stopped", {});
        });
    }

    private handleJointControlCommand(data: JointControlData): void {
        if (!this.robotArm) return;
        const duration = data.duration || 0.5;

        if (data.jointName && data.angle !== undefined) {
            this.robotArm.animateJointAngle(data.jointName, data.angle, duration, {
                onUpdate: () => this.onJointUpdateCallback?.(),
                onComplete: () => this.onJointUpdateCallback?.(),
            });
        } else if (data.joints) {
            const jointAngles: Record<string, number> = {};
            data.joints.forEach((j) => {
                jointAngles[j.name] = j.angle;
            });
            this.robotArm.animateMultipleJoints(jointAngles, duration, {
                onUpdate: () => this.onJointUpdateCallback?.(),
                onComplete: () => this.onJointUpdateCallback?.(),
            });
        }

        if (data.gripperOpenness !== undefined) {
            this.robotArm.animateGripperOpenness(data.gripperOpenness, duration);
        }

        this.onRemoteCommandCallback?.("joint_control", data);
    }

    private handleSequenceStart(data: any): void {
        this.onSequenceCallback?.("start", data);
        this.animationQueue.startSequence({
            onFrameUpdate: (frame) => {
                this.onSequenceCallback?.("frame_update", { frame });
                this.onJointUpdateCallback?.();
            },
            onFrameComplete: (frame) => {
                this.onSequenceCallback?.("playback_complete", { frame });
                this.onJointUpdateCallback?.();
            },
            onError: (frame, error) => {
                this.onSequenceCallback?.("error", { error, frame });
            },
        });
    }

    private startStateSync(): void {
        if (!this.robotArm || this.stateSyncInterval) return;
        this.isStateSyncEnabled = true;
        this.stateSyncInterval = window.setInterval(() => {
            this.syncRobotState();
        }, this.config.stateSyncInterval);
    }

    private stopStateSync(): void {
        this.isStateSyncEnabled = false;
        if (this.stateSyncInterval) {
            clearInterval(this.stateSyncInterval);
            this.stateSyncInterval = null;
        }
    }

    private syncRobotState(): void {
        if (!this.robotArm || !this.client || !this.isStateSyncEnabled) return;
        this.client.sendRobotState(this.buildRobotStateData());
    }

    private buildRobotStateData(): RobotStateData {
        const joints = this.robotArm!.getJointConfigs().map((c) => ({
            name: c.name,
            angle: c.currentAngle,
        }));

        const gripperConfigs = this.robotArm!.getGripperConfigs();
        const gripper = {
            openness: this.calculateGripperOpenness(gripperConfigs),
            isGripping: this.calculateGripperOpenness(gripperConfigs) < 0.3,
        };

        let endEffector;
        const model = this.robotArm!.getModel();
        if (model) {
            const pos = TrajectoryVisualizer.getEndEffectorPosition(model);
            if (pos) {
                endEffector = {
                    position: [pos.x, pos.y, pos.z] as [number, number, number],
                    orientation: [0, 0, 0, 1] as [number, number, number, number],
                };
            }
        }

        return { joints, gripper, endEffector, timestamp: Date.now() };
    }

    private calculateGripperOpenness(configs: JointConfig[]): number {
        const g = configs.find((c) => c.name === "gripper1");
        if (!g) return 0;
        return Math.max(0, Math.min(1, (g.currentAngle - g.minAngle) / (g.maxAngle - g.minAngle)));
    }

    sendCurrentState(): void {
        if (this.robotArm && this.client) {
            this.client.sendRobotState(this.buildRobotStateData());
        }
    }

    sendJointControl(data: JointControlData): void {
        this.client?.sendJointControl(data);
    }

    requestClientsList(): void {
        this.client?.requestClientsList();
    }

    emergencyStop(): void {
        this.client?.emergencyStop();
    }

    resetRobot(): void {
        this.client?.resetRobot();
    }

    requestTestSequence(): void {
        this.client?.requestTestSequence();
    }

    stopTestSequence(): void {
        this.client?.stopTestSequence();
        this.animationQueue.stop();
    }

    isConnected(): boolean {
        return this.client?.isWebSocketConnected() || false;
    }

    onConnectionStatus(cb: (connected: boolean) => void): void {
        this.onConnectionStatusCallback = cb;
    }

    onRemoteCommand(cb: (command: string, data: any) => void): void {
        this.onRemoteCommandCallback = cb;
    }

    onSequence(cb: (event: string, data: any) => void): void {
        this.onSequenceCallback = cb;
    }

    onJointUpdate(cb: () => void): void {
        this.onJointUpdateCallback = cb;
    }

    updateConfig(newConfig: Partial<WebSocketConfig>): void {
        this.config = { ...this.config, ...newConfig };
        if (newConfig.stateSyncInterval && this.isStateSyncEnabled) {
            this.stopStateSync();
            this.startStateSync();
        }
        if (newConfig.enableStateSync !== undefined) {
            if (newConfig.enableStateSync && !this.isStateSyncEnabled) this.startStateSync();
            else if (!newConfig.enableStateSync && this.isStateSyncEnabled) this.stopStateSync();
        }
    }

    getConfig(): WebSocketConfig {
        return { ...this.config };
    }
}
