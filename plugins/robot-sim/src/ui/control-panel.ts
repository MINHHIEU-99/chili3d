// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@chili3d/core";
import { button, div, input, label, span } from "@chili3d/element";
import type { JointConfig, WeldLineAction } from "../core/joint-config";
import type { RobotArm } from "../core/robot-arm";
import { type WebSocketConfig, WebSocketManager } from "../core/websocket-manager";
import { validateWeldLineAction, WeldLineExecutor, type WeldLogEntry } from "../core/weld-line-executor";
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

    // Weld
    private weldExecutor = new WeldLineExecutor();
    private pendingWeldAction: WeldLineAction | null = null;
    private weldProgressSlider: HTMLInputElement | null = null;
    private weldProgressLabel: HTMLElement | null = null;
    private weldStatusLabel: HTMLElement | null = null;
    private weldPlayBtn: HTMLButtonElement | null = null;
    private weldPauseBtn: HTMLButtonElement | null = null;
    private weldStopBtn: HTMLButtonElement | null = null;
    private isDraggingWeldProgress = false;
    private weldStartMarker: HTMLElement | null = null;
    private weldEndMarker: HTMLElement | null = null;
    private weldLogBody: HTMLTableSectionElement | null = null;

    // WebSocket
    private wsManager: WebSocketManager | null = null;
    private wsStatusLabel: HTMLElement | null = null;
    private wsConnectBtn: HTMLButtonElement | null = null;
    private wsDisconnectBtn: HTMLButtonElement | null = null;
    private wsSeqStatusLabel: HTMLElement | null = null;
    private wsSeqFrameLabel: HTMLElement | null = null;

    // PubSub subscription callback (kept for unsubscribe)
    private weldActionCallback: ((action: WeldLineAction) => void) | null = null;

    constructor(private robotArm: RobotArm) {}

    render(): HTMLElement {
        // Subscribe to weld action from the toolbar command
        this.weldActionCallback = (action: WeldLineAction) => this.loadWeldAction(action);
        PubSub.default.sub("weldActionReady" as any, this.weldActionCallback as any);

        const sections: (HTMLElement | null)[] = [
            this.createWebSocketSection(),
            this.createJointControlSection(),
            this.createGripperSection(),
            this.createResetSection(),
            this.createActionSection(),
            this.createWeldActionSection(),
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

    // ─── Keyframe Action Sequence Section ───

    private createActionSection(): HTMLElement {
        const fileInput = input({
            type: "file",
            accept: ".json",
            className: style.hiddenInput,
        }) as HTMLInputElement;

        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const json = JSON.parse(text);
                if (validateWeldLineAction(json)) {
                    this.loadWeldAction(json);
                } else {
                    await this.robotArm.loadActionSequenceFile(file);
                }
            } catch {
                console.error("Failed to load action JSON");
            }
            fileInput.value = "";
        });

        const uploadBtn = button({
            textContent: "Load Action JSON",
            className: style.actionButton,
            onclick: () => fileInput.click(),
        }) as HTMLButtonElement;

        // Playback controls (keyframe sequence)
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

    // ─── Weld Line Action Section ───

    private createWeldActionSection(): HTMLElement {
        this.weldStatusLabel = span({ textContent: "No weld loaded" });

        this.weldPlayBtn = button({
            textContent: "Play",
            className: `${style.actionButton} ${style.playButton}`,
            onclick: () => this.handleWeldPlay(),
        }) as HTMLButtonElement;
        this.weldPlayBtn.disabled = true;

        this.weldPauseBtn = button({
            textContent: "Pause",
            className: style.actionButton,
            onclick: () => this.handleWeldPause(),
        }) as HTMLButtonElement;
        this.weldPauseBtn.style.display = "none";

        this.weldStopBtn = button({
            textContent: "Stop",
            className: `${style.actionButton} ${style.stopButton}`,
            onclick: () => this.handleWeldStop(),
        }) as HTMLButtonElement;
        this.weldStopBtn.style.display = "none";

        // Progress slider
        this.weldProgressLabel = span({ textContent: "0%" });
        this.weldProgressSlider = input({
            type: "range",
            min: "0",
            max: "1",
            step: "0.001",
            value: "0",
            className: style.slider,
        }) as HTMLInputElement;

        this.weldProgressSlider.addEventListener("mousedown", () => {
            this.isDraggingWeldProgress = true;
            // Pause while dragging so the user can scrub freely
            if (this.weldExecutor.getState() === "playing") {
                this.weldExecutor.pause();
            }
        });

        this.weldProgressSlider.addEventListener("input", () => {
            const progress = parseFloat(this.weldProgressSlider!.value);
            this.weldExecutor.seekTo(progress);
            this.weldProgressLabel!.textContent = `${Math.round(progress * 100)}%`;
            this.refreshAllSliders();
        });

        this.weldProgressSlider.addEventListener("mouseup", () => {
            this.isDraggingWeldProgress = false;
        });

        // Marker for weld start point
        this.weldStartMarker = div({ className: `${style.progressMarker} ${style.markerStart}` });
        this.weldStartMarker.appendChild(span({ textContent: "S", className: style.markerLabel }));
        this.weldStartMarker.style.display = "none";
        this.weldStartMarker.addEventListener("click", () => {
            const markers = this.weldExecutor.getMarkers();
            this.weldExecutor.seekTo(markers.start);
            if (this.weldProgressSlider) this.weldProgressSlider.value = String(markers.start);
            if (this.weldProgressLabel) {
                this.weldProgressLabel.textContent = `${Math.round(markers.start * 100)}%`;
            }
            this.refreshAllSliders();
        });

        // Marker for weld end point
        this.weldEndMarker = div({ className: `${style.progressMarker} ${style.markerEnd}` });
        this.weldEndMarker.appendChild(span({ textContent: "E", className: style.markerLabel }));
        this.weldEndMarker.style.display = "none";
        this.weldEndMarker.addEventListener("click", () => {
            const markers = this.weldExecutor.getMarkers();
            this.weldExecutor.seekTo(markers.end);
            if (this.weldProgressSlider) this.weldProgressSlider.value = String(markers.end);
            if (this.weldProgressLabel) {
                this.weldProgressLabel.textContent = `${Math.round(markers.end * 100)}%`;
            }
            this.refreshAllSliders();
        });

        const progressContainer = div(
            { className: style.progressContainer },
            this.weldProgressSlider,
            this.weldStartMarker,
            this.weldEndMarker,
        );

        // Speed slider
        const speedValueLabel = span({ textContent: "50", className: style.sliderValue });
        const speedSlider = input({
            type: "range",
            min: "5",
            max: "500",
            step: "5",
            value: "50",
            className: style.slider,
        }) as HTMLInputElement;

        speedSlider.addEventListener("input", () => {
            const speed = parseFloat(speedSlider.value);
            speedValueLabel.textContent = String(speed);
            this.weldExecutor.setSpeed(speed);
        });

        return div(
            { className: style.section },
            div({ className: style.sectionHeader }, span({ textContent: "Weld Line" }), this.weldStatusLabel),
            div({ className: style.buttonRow }, this.weldPlayBtn, this.weldPauseBtn, this.weldStopBtn),
            div(
                { className: style.sliderRow },
                label({ textContent: "Progress" }),
                progressContainer,
                this.weldProgressLabel,
            ),
            div(
                { className: style.sliderRow },
                label({ textContent: "Speed", className: style.sliderLabel }),
                speedSlider,
                speedValueLabel,
                span({ textContent: "u/s", className: style.sliderUnit }),
            ),
            this.createWeldLogTable(),
        );
    }

    private createWeldLogTable(): HTMLElement {
        const table = document.createElement("table");
        table.className = style.logTable;

        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (const col of ["Time", "Point", "X", "Y", "Z", "W", "P", "R"]) {
            const th = document.createElement("th");
            th.textContent = col;
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        this.weldLogBody = document.createElement("tbody");
        table.appendChild(this.weldLogBody);

        const container = div({ className: style.logTableContainer });
        container.appendChild(table);
        return container;
    }

    private addWeldLogRow(entry: WeldLogEntry): void {
        if (!this.weldLogBody) return;

        const row = document.createElement("tr");
        const time = entry.time.split("T")[1]?.replace("Z", "") ?? entry.time;
        const p = entry.pose;
        const values = [
            time,
            entry.label,
            p.x.toFixed(2),
            p.y.toFixed(2),
            p.z.toFixed(2),
            p.w.toFixed(2),
            p.p.toFixed(2),
            p.r.toFixed(2),
        ];

        for (const val of values) {
            const td = document.createElement("td");
            td.textContent = val;
            row.appendChild(td);
        }
        this.weldLogBody.appendChild(row);

        // Auto-scroll to bottom
        const container = this.weldLogBody.closest(`.${style.logTableContainer}`);
        if (container) container.scrollTop = container.scrollHeight;
    }

    private clearWeldLog(): void {
        if (this.weldLogBody) this.weldLogBody.innerHTML = "";
    }

    private loadWeldAction(action: WeldLineAction): void {
        this.pendingWeldAction = action;
        this.clearWeldLog();

        const ok = this.weldExecutor.prepare(this.robotArm, action, {
            onProgress: (progress) => {
                if (!this.isDraggingWeldProgress) {
                    if (this.weldProgressSlider) this.weldProgressSlider.value = String(progress);
                    if (this.weldProgressLabel) {
                        this.weldProgressLabel.textContent = `${Math.round(progress * 100)}%`;
                    }
                }
                this.refreshAllSliders();
            },
            onComplete: () => {
                this.updateWeldButtonStates();
                this.refreshAllSliders();
            },
            onError: (error) => {
                if (this.weldStatusLabel) this.weldStatusLabel.textContent = `Error: ${error}`;
                this.updateWeldButtonStates();
            },
            onSceneUpdate: () => {
                // handled by notifyJointsChanged
            },
            onStateChange: (state) => {
                this.updateWeldButtonStates();
            },
            onLog: (entry) => {
                this.addWeldLogRow(entry);
            },
        });

        if (ok) {
            if (this.weldStatusLabel) this.weldStatusLabel.textContent = "Ready";
            if (this.weldProgressSlider) this.weldProgressSlider.value = "0";
            if (this.weldProgressLabel) this.weldProgressLabel.textContent = "0%";
            this.updateWeldMarkers();
        }
        this.updateWeldButtonStates();
    }

    private handleWeldPlay(): void {
        const state = this.weldExecutor.getState();
        if (state === "paused" || state === "completed") {
            this.weldExecutor.play();
        }
        this.updateWeldButtonStates();
    }

    private handleWeldPause(): void {
        const state = this.weldExecutor.getState();
        if (state === "playing") {
            this.weldExecutor.pause();
        } else if (state === "paused") {
            this.weldExecutor.play();
        }
        this.updateWeldButtonStates();
    }

    private handleWeldStop(): void {
        this.weldExecutor.stop();
        this.pendingWeldAction = null;
        if (this.weldProgressSlider) this.weldProgressSlider.value = "0";
        if (this.weldProgressLabel) this.weldProgressLabel.textContent = "0%";
        if (this.weldStatusLabel) this.weldStatusLabel.textContent = "No weld loaded";
        if (this.weldStartMarker) this.weldStartMarker.style.display = "none";
        if (this.weldEndMarker) this.weldEndMarker.style.display = "none";
        this.updateWeldButtonStates();
    }

    private updateWeldMarkers(): void {
        const markers = this.weldExecutor.getMarkers();
        if (this.weldStartMarker) {
            this.weldStartMarker.style.display = "";
            this.weldStartMarker.style.left = `${markers.start * 100}%`;
        }
        if (this.weldEndMarker) {
            this.weldEndMarker.style.display = "";
            this.weldEndMarker.style.left = `${markers.end * 100}%`;
        }
    }

    private updateWeldButtonStates(): void {
        const state = this.weldExecutor.getState();
        const isPrepared = this.weldExecutor.isPrepared();

        if (this.weldPlayBtn) {
            this.weldPlayBtn.disabled = !isPrepared || state === "playing";
            this.weldPlayBtn.style.display = state === "playing" ? "none" : "";
        }
        if (this.weldPauseBtn) {
            this.weldPauseBtn.style.display = state === "playing" || state === "paused" ? "" : "none";
            this.weldPauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
        }
        if (this.weldStopBtn) {
            this.weldStopBtn.style.display = isPrepared && state !== "idle" ? "" : "none";
        }
        if (this.weldStatusLabel) {
            const labels: Record<string, string> = {
                idle: "No weld loaded",
                paused: "Paused",
                playing: "Playing",
                completed: "Completed",
            };
            this.weldStatusLabel.textContent = labels[state] ?? state;
        }
    }

    // ─── Trajectory Section ───

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

    // ─── Joint Sliders ───

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

    // ─── Slider refresh ───

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

    // ─── Keyframe sequence playback ───

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

    // ─── Update loop ───

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
        this.weldExecutor.stop();
        if (this.weldActionCallback) {
            PubSub.default.remove("weldActionReady" as any, this.weldActionCallback as any);
            this.weldActionCallback = null;
        }
        this.wsManager?.disconnect();
        this.wsManager = null;
        this.jointSliders.clear();
        this.jointValueInputs.clear();
    }
}
