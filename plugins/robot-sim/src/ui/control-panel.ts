// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { button, div, input, label, span } from "@chili3d/element";
import type { JointConfig } from "../core/joint-config";
import type { RobotArm } from "../core/robot-arm";
import { type WebSocketConfig, WebSocketManager } from "../core/websocket-manager";
import style from "../styles/robot-sim.module.css";

export class RobotControlPanel {
    private jointSliders: Map<string, HTMLInputElement> = new Map();
    private jointValueInputs: Map<string, HTMLInputElement> = new Map();
    private progressSlider: HTMLInputElement | null = null;
    private progressLabel: HTMLElement | null = null;
    private frameIdLabel: HTMLElement | null = null;
    private gripperStateLabel: HTMLElement | null = null;
    private playBtn: HTMLButtonElement | null = null;
    private pauseBtn: HTMLButtonElement | null = null;
    private stopBtn: HTMLButtonElement | null = null;
    private isPlaying = false;
    private isPaused = false;
    private isDraggingProgress = false;
    private updateAnimationId: number | null = null;

    // WebSocket
    private wsManager: WebSocketManager | null = null;
    private wsStatusLabel: HTMLElement | null = null;
    private wsConnectBtn: HTMLButtonElement | null = null;
    private wsDisconnectBtn: HTMLButtonElement | null = null;
    private wsSeqStatusLabel: HTMLElement | null = null;
    private wsSeqFrameLabel: HTMLElement | null = null;

    constructor(private robotArm: RobotArm) {}

    render(): HTMLElement {
        const sections: (HTMLElement | null)[] = [
            this.createWebSocketSection(),
            this.createJointControlSection(),
            this.createGripperSection(),
            this.createResetSection(),
            this.createActionSection(),
            this.createTrajectorySection(),
        ];

        const container = div(
            { className: style.panelContainer },
            ...(sections.filter(Boolean) as HTMLElement[]),
        );

        this.startUpdateLoop();
        return container;
    }

    private createWebSocketSection(): HTMLElement {
        const urlInput = input({
            type: "text",
            value: "ws://localhost:9000",
            className: style.textInput,
        }) as HTMLInputElement;

        this.wsStatusLabel = span({ textContent: "Disconnected", className: style.wsStatus });

        this.wsConnectBtn = button({
            textContent: "Connect",
            className: `${style.actionButton} ${style.playButton}`,
            onclick: () => this.handleWsConnect(urlInput.value),
        }) as HTMLButtonElement;

        this.wsDisconnectBtn = button({
            textContent: "Disconnect",
            className: `${style.actionButton} ${style.stopButton}`,
            onclick: () => this.handleWsDisconnect(),
        }) as HTMLButtonElement;
        this.wsDisconnectBtn.style.display = "none";

        const sendStateBtn = button({
            textContent: "Send State",
            className: style.actionButton,
            onclick: () => this.wsManager?.sendCurrentState(),
        }) as HTMLButtonElement;

        const eStopBtn = button({
            textContent: "E-Stop",
            className: `${style.actionButton} ${style.stopButton}`,
            onclick: () => this.wsManager?.emergencyStop(),
        }) as HTMLButtonElement;

        const resetBtn = button({
            textContent: "Reset",
            className: style.actionButton,
            onclick: () => this.wsManager?.resetRobot(),
        }) as HTMLButtonElement;

        // Test sequence controls
        this.wsSeqStatusLabel = span({ textContent: "Idle" });
        this.wsSeqFrameLabel = span({ textContent: "--" });

        const startSeqBtn = button({
            textContent: "Start Seq",
            className: style.actionButton,
            onclick: () => this.wsManager?.requestTestSequence(),
        }) as HTMLButtonElement;

        const stopSeqBtn = button({
            textContent: "Stop Seq",
            className: style.actionButton,
            onclick: () => this.wsManager?.stopTestSequence(),
        }) as HTMLButtonElement;

        const syncCheckbox = input({
            type: "checkbox",
            checked: true,
        }) as HTMLInputElement;
        syncCheckbox.addEventListener("change", () => {
            this.wsManager?.updateConfig({ enableStateSync: syncCheckbox.checked });
        });

        return div(
            { className: style.section },
            div({ className: style.sectionHeader }, span({ textContent: "WebSocket" }), this.wsStatusLabel),
            div(
                { className: style.sliderRow },
                label({ textContent: "Server", className: style.sliderLabel }),
                urlInput,
            ),
            div({ className: style.buttonRow }, this.wsConnectBtn, this.wsDisconnectBtn),
            div({ className: style.checkboxRow }, syncCheckbox, label({ textContent: "State sync" })),
            div({ className: style.buttonRow }, sendStateBtn, eStopBtn, resetBtn),
            div({ className: style.buttonRow }, startSeqBtn, stopSeqBtn),
            div(
                { className: style.statusRow },
                div({ className: style.statusItem }, label({ textContent: "Seq: " }), this.wsSeqStatusLabel),
                div({ className: style.statusItem }, label({ textContent: "Frame: " }), this.wsSeqFrameLabel),
            ),
        );
    }

    private async handleWsConnect(url: string): Promise<void> {
        if (this.wsManager?.isConnected()) return;

        try {
            if (this.wsConnectBtn) {
                this.wsConnectBtn.textContent = "Connecting...";
                this.wsConnectBtn.disabled = true;
            }

            const config: WebSocketConfig = {
                url,
                clientName: "Chili3D Robot Simulator",
                enableStateSync: true,
                stateSyncInterval: 100,
            };

            this.wsManager = new WebSocketManager(config);
            await this.wsManager.initialize(this.robotArm);

            this.wsManager.onConnectionStatus((connected) => {
                this.updateWsStatus(connected);
            });

            this.wsManager.onJointUpdate(() => {
                this.refreshAllSliders();
            });

            this.wsManager.onSequence((event, data) => {
                this.handleWsSequenceEvent(event, data);
            });

            await this.wsManager.connect();
            this.updateWsStatus(true);
        } catch (error) {
            console.error("WebSocket connection failed:", error);
            this.updateWsStatus(false);
        }
    }

    private handleWsDisconnect(): void {
        this.wsManager?.disconnect();
        this.wsManager = null;
        this.updateWsStatus(false);
    }

    private updateWsStatus(connected: boolean): void {
        if (this.wsStatusLabel) {
            this.wsStatusLabel.textContent = connected ? "Connected" : "Disconnected";
            this.wsStatusLabel.className = connected
                ? `${style.wsStatus} ${style.wsConnected}`
                : style.wsStatus;
        }
        if (this.wsConnectBtn) {
            this.wsConnectBtn.style.display = connected ? "none" : "";
            this.wsConnectBtn.textContent = "Connect";
            this.wsConnectBtn.disabled = false;
        }
        if (this.wsDisconnectBtn) {
            this.wsDisconnectBtn.style.display = connected ? "" : "none";
        }
    }

    private handleWsSequenceEvent(event: string, data: any): void {
        switch (event) {
            case "start":
                if (this.wsSeqStatusLabel) this.wsSeqStatusLabel.textContent = "Receiving";
                if (this.wsSeqFrameLabel) this.wsSeqFrameLabel.textContent = "--";
                break;
            case "frame_update":
                if (this.wsSeqStatusLabel) this.wsSeqStatusLabel.textContent = "Playing";
                if (this.wsSeqFrameLabel) this.wsSeqFrameLabel.textContent = String(data.frame.id);
                this.refreshAllSliders();
                break;
            case "playback_complete":
                this.refreshAllSliders();
                break;
            case "complete":
                if (this.wsSeqStatusLabel) this.wsSeqStatusLabel.textContent = "Completed";
                if (this.wsSeqFrameLabel) this.wsSeqFrameLabel.textContent = "--";
                break;
            case "stopped":
                if (this.wsSeqStatusLabel) this.wsSeqStatusLabel.textContent = "Stopped";
                if (this.wsSeqFrameLabel) this.wsSeqFrameLabel.textContent = "--";
                break;
            case "error":
                if (this.wsSeqStatusLabel) this.wsSeqStatusLabel.textContent = "Error";
                break;
        }
    }

    private createJointControlSection(): HTMLElement {
        const jointConfigs = this.robotArm.getJointConfigs();

        const header = div(
            { className: style.sectionHeader },
            span({ textContent: "Joint Control" }),
            this.createAxisHelperToggle(),
        );

        const sliders = jointConfigs.map((config) => this.createJointSlider(config, false));

        return div({ className: style.section }, header, ...sliders);
    }

    private createGripperSection(): HTMLElement | null {
        const gripperConfigs = this.robotArm.getGripperConfigs();
        if (gripperConfigs.length === 0) return null;

        const gripperSliders = gripperConfigs.map((config) => this.createJointSlider(config, true));

        const opennessSlider = this.createSliderRow("Openness", 0, 1, 0.01, 0, (value) => {
            if (!this.isPlaying) {
                this.robotArm.setGripperOpenness(value);
                this.refreshGripperSliders();
            }
        });

        return div(
            { className: style.section },
            div({ className: style.sectionHeader }, span({ textContent: "Gripper" })),
            ...gripperSliders,
            opennessSlider,
        );
    }

    private createResetSection(): HTMLElement {
        const pauseBtn = button({
            textContent: "Pause",
            className: style.actionButton,
            onclick: () => {
                this.robotArm.stopAllJointAnimations();
                this.refreshAllSliders();
            },
        }) as HTMLButtonElement;

        const zeroBtn = button({
            textContent: "Zero Pose",
            className: style.actionButton,
            onclick: () => {
                this.robotArm.reset0({
                    onUpdate: () => this.refreshAllSliders(),
                    onComplete: () => this.refreshAllSliders(),
                });
            },
        }) as HTMLButtonElement;

        return div({ className: style.buttonRow }, zeroBtn, pauseBtn);
    }

    private createActionSection(): HTMLElement {
        // Action file upload
        const fileInput = input({
            type: "file",
            accept: ".json",
            className: style.hiddenInput,
        }) as HTMLInputElement;

        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                await this.robotArm.loadActionSequenceFile(file);
            } catch {
                console.error("Failed to load action sequence");
            }
            fileInput.value = "";
        });

        const uploadBtn = button({
            textContent: "Load Action JSON",
            className: style.actionButton,
            onclick: () => fileInput.click(),
        }) as HTMLButtonElement;

        // Playback controls
        this.playBtn = button({
            textContent: "Play",
            className: `${style.actionButton} ${style.playButton}`,
            onclick: () => this.playAction(),
        }) as HTMLButtonElement;

        this.pauseBtn = button({
            textContent: "Pause",
            className: style.actionButton,
            onclick: () => this.togglePause(),
        }) as HTMLButtonElement;
        this.pauseBtn.style.display = "none";

        this.stopBtn = button({
            textContent: "Stop",
            className: `${style.actionButton} ${style.stopButton}`,
            onclick: () => this.stopAction(),
        }) as HTMLButtonElement;
        this.stopBtn.style.display = "none";

        // Progress slider
        this.progressLabel = span({ textContent: "0%" });
        this.progressSlider = input({
            type: "range",
            min: "0",
            max: "1",
            step: "0.01",
            value: "0",
            className: style.slider,
        }) as HTMLInputElement;

        this.progressSlider.addEventListener("input", () => {
            if (this.isPlaying) return;
            this.isDraggingProgress = true;
            const progress = parseFloat(this.progressSlider!.value);
            this.robotArm.setAnimationProgress(progress);
            this.progressLabel!.textContent = `${Math.round(progress * 100)}%`;
            this.refreshAllSliders();
            this.isDraggingProgress = false;
        });

        // Status display
        this.frameIdLabel = span({ textContent: "0" });
        this.gripperStateLabel = span({ textContent: "Open" });

        const statusRow = div(
            { className: style.statusRow },
            div({ className: style.statusItem }, label({ textContent: "Frame: " }), this.frameIdLabel),
            div({ className: style.statusItem }, label({ textContent: "Gripper: " }), this.gripperStateLabel),
        );

        return div(
            { className: style.section },
            div({ className: style.sectionHeader }, span({ textContent: "Action Sequence" })),
            div({ className: style.buttonRow }, uploadBtn),
            div({ className: style.buttonRow }, this.playBtn, this.pauseBtn, this.stopBtn),
            div(
                { className: style.sliderRow },
                label({ textContent: "Progress" }),
                this.progressSlider,
                this.progressLabel,
            ),
            statusRow,
            fileInput,
        );
    }

    private createTrajectorySection(): HTMLElement {
        const visualizer = this.robotArm.getTrajectoryVisualizer();
        if (!visualizer) return div();

        visualizer.setVisible(false);

        const visibleCheckbox = input({
            type: "checkbox",
            checked: false,
        }) as HTMLInputElement;
        visibleCheckbox.addEventListener("change", () => {
            visualizer.setVisible(visibleCheckbox.checked);
        });

        const clearBtn = button({
            textContent: "Clear Trajectory",
            className: style.actionButton,
            onclick: () => this.robotArm.clearTrajectory(),
        }) as HTMLButtonElement;

        return div(
            { className: style.section },
            div({ className: style.sectionHeader }, span({ textContent: "Trajectory" })),
            div({ className: style.checkboxRow }, visibleCheckbox, label({ textContent: "Show trajectory" })),
            div({ className: style.buttonRow }, clearBtn),
        );
    }

    private createAxisHelperToggle(): HTMLElement {
        const checkbox = input({
            type: "checkbox",
            checked: false,
        }) as HTMLInputElement;
        checkbox.addEventListener("change", () => {
            this.robotArm.toggleGroundGrid(checkbox.checked);
        });

        return div({ className: style.checkboxRow }, checkbox, label({ textContent: "Ground Grid" }));
    }

    private createJointSlider(config: JointConfig, isGripper: boolean): HTMLElement {
        const unit = config.type === "linear" ? "mm" : "°";
        const step = config.type === "linear" ? "10" : "1";

        const valueInput = input({
            type: "number",
            min: String(config.minAngle),
            max: String(config.maxAngle),
            step,
            value: String(parseFloat(config.currentAngle.toFixed(1))),
            className: style["sliderValue"],
        }) as HTMLInputElement;

        const slider = input({
            type: "range",
            min: String(config.minAngle),
            max: String(config.maxAngle),
            step,
            value: String(config.currentAngle),
            className: style.slider,
        }) as HTMLInputElement;

        const applyAngle = (angle: number) => {
            if (this.isPlaying || this.isDraggingProgress) return;
            const clamped = Math.max(config.minAngle, Math.min(config.maxAngle, angle));
            if (isGripper) {
                this.robotArm.setGripperAngle(config.name, clamped);
            } else {
                this.robotArm.setJointAngle(config.name, clamped);
            }
        };

        slider.addEventListener("input", () => {
            const angle = parseFloat(slider.value);
            applyAngle(angle);
            valueInput.value = String(parseFloat(angle.toFixed(1)));
        });

        valueInput.addEventListener("change", () => {
            const angle = parseFloat(valueInput.value);
            if (Number.isNaN(angle)) return;
            applyAngle(angle);
            slider.value = String(Math.max(config.minAngle, Math.min(config.maxAngle, angle)));
            valueInput.value = String(
                parseFloat(Math.max(config.minAngle, Math.min(config.maxAngle, angle)).toFixed(1)),
            );
        });

        this.jointSliders.set(config.name, slider);
        this.jointValueInputs.set(config.name, valueInput);

        const unitLabel = span({ textContent: unit, className: style.sliderUnit });

        return div(
            { className: style.sliderRow },
            label({ textContent: config.name, className: style.sliderLabel }),
            slider,
            valueInput,
            unitLabel,
        );
    }

    private createSliderRow(
        labelText: string,
        min: number,
        max: number,
        step: number,
        initialValue: number,
        onChange: (value: number) => void,
    ): HTMLElement {
        const valueLabel = span({
            textContent: `${initialValue.toFixed(2)}`,
            className: style.sliderValue,
        });

        const slider = input({
            type: "range",
            min: String(min),
            max: String(max),
            step: String(step),
            value: String(initialValue),
            className: style.slider,
        }) as HTMLInputElement;

        slider.addEventListener("input", () => {
            const value = parseFloat(slider.value);
            valueLabel.textContent = `${value.toFixed(2)}`;
            onChange(value);
        });

        return div(
            { className: style.sliderRow },
            label({ textContent: labelText, className: style.sliderLabel }),
            slider,
            valueLabel,
        );
    }

    private refreshAllSliders(): void {
        const jointConfigs = this.robotArm.getJointConfigs();
        const gripperConfigs = this.robotArm.getGripperConfigs();

        [...jointConfigs, ...gripperConfigs].forEach((config) => {
            const slider = this.jointSliders.get(config.name);
            const valueInput = this.jointValueInputs.get(config.name);
            if (slider) {
                slider.value = String(config.currentAngle);
            }
            if (valueInput) {
                valueInput.value = String(parseFloat(config.currentAngle.toFixed(1)));
            }
        });
    }

    private refreshGripperSliders(): void {
        const gripperConfigs = this.robotArm.getGripperConfigs();
        gripperConfigs.forEach((config) => {
            const slider = this.jointSliders.get(config.name);
            const valueInput = this.jointValueInputs.get(config.name);
            if (slider) {
                slider.value = String(config.currentAngle);
            }
            if (valueInput) {
                valueInput.value = String(parseFloat(config.currentAngle.toFixed(1)));
            }
        });
    }

    private async playAction(): Promise<void> {
        try {
            this.isPlaying = true;
            this.isPaused = false;
            this.updateButtonStates();

            await this.robotArm.playActionSequence("", {
                onUpdate: () => this.refreshAllSliders(),
                onProgressUpdate: (progress) => {
                    if (this.progressSlider) {
                        this.progressSlider.value = String(progress);
                    }
                    if (this.progressLabel) {
                        this.progressLabel.textContent = `${Math.round(progress * 100)}%`;
                    }
                },
                onStateChange: (frameId) => {
                    if (this.frameIdLabel) {
                        this.frameIdLabel.textContent = String(frameId);
                    }
                },
                onGripperChange: (isGripping) => {
                    if (this.gripperStateLabel) {
                        this.gripperStateLabel.textContent = isGripping ? "Closed" : "Open";
                    }
                },
                onComplete: () => {
                    this.isPlaying = false;
                    this.isPaused = false;
                    this.updateButtonStates();
                },
            });
        } catch (error) {
            console.error("Failed to play action:", error);
            this.isPlaying = false;
            this.isPaused = false;
            this.updateButtonStates();
        }
    }

    private togglePause(): void {
        const state = this.robotArm.getAnimationState();
        if (state.isPlaying && !state.isPaused) {
            this.robotArm.pauseAnimation();
            this.isPaused = true;
            this.isPlaying = false;
        } else if (state.isPaused) {
            this.robotArm.resumeAnimation();
            this.isPaused = false;
            this.isPlaying = true;
        }
        this.updateButtonStates();
    }

    private stopAction(): void {
        this.robotArm.stopAnimation();
        this.robotArm.clearTrajectory();
        this.robotArm.reset0({
            onUpdate: () => {
                this.refreshAllSliders();
            },
            onComplete: () => {
                this.isPlaying = false;
                this.isPaused = false;
                this.updateButtonStates();
                if (this.progressSlider) this.progressSlider.value = "0";
                if (this.progressLabel) this.progressLabel.textContent = "0%";
                if (this.frameIdLabel) this.frameIdLabel.textContent = "0";
                if (this.gripperStateLabel) this.gripperStateLabel.textContent = "Open";
            },
        });
    }

    private updateButtonStates(): void {
        if (!this.playBtn || !this.pauseBtn || !this.stopBtn) return;

        if (this.isPlaying || this.isPaused) {
            this.playBtn.style.display = "none";
            this.pauseBtn.style.display = "";
            this.stopBtn.style.display = "";
            this.pauseBtn.textContent = this.isPaused ? "Resume" : "Pause";
        } else {
            this.playBtn.style.display = "";
            this.pauseBtn.style.display = "none";
            this.stopBtn.style.display = "none";
        }
    }

    private startUpdateLoop(): void {
        const update = () => {
            if (this.isPlaying) {
                this.refreshAllSliders();
            }
            this.updateAnimationId = requestAnimationFrame(update);
        };
        this.updateAnimationId = requestAnimationFrame(update);
    }

    dispose(): void {
        if (this.updateAnimationId !== null) {
            cancelAnimationFrame(this.updateAnimationId);
            this.updateAnimationId = null;
        }
        this.wsManager?.disconnect();
        this.wsManager = null;
        this.jointSliders.clear();
        this.jointValueInputs.clear();
    }
}
