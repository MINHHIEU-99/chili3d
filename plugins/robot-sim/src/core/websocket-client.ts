// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface WebSocketMessage {
    type: string;
    data: any;
}

export interface ClientInfo {
    id: number;
    type: "simulator";
    name: string;
}

export interface RobotStateData {
    joints: Array<{ name: string; angle: number }>;
    gripper?: { openness: number; isGripping?: boolean };
    endEffector?: {
        position: [number, number, number];
        orientation: [number, number, number, number];
    };
    timestamp: number;
}

export interface JointControlData {
    jointName?: string;
    angle?: number;
    joints?: Array<{ name: string; angle: number }>;
    gripperOpenness?: number;
    duration?: number;
}

export type WebSocketEventHandler = (data: any) => void;

export class WebSocketClient {
    private ws: WebSocket | null = null;
    private heartbeatInterval: number | null = null;
    private eventHandlers: Map<string, WebSocketEventHandler[]> = new Map();
    private connected = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 3;
    private reconnectDelay = 2000;
    private isReconnecting = false;
    private isManualDisconnect = false;

    constructor(
        private url: string,
        private clientInfo: ClientInfo,
    ) {}

    async connect(): Promise<void> {
        if (this.ws) this.cleanupConnection();

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    this.connected = true;
                    this.resetReconnectState();
                    this.register();
                    this.startHeartbeat();
                    this.emit("connected", { clientInfo: this.clientInfo });
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    try {
                        const message: WebSocketMessage = JSON.parse(event.data);
                        this.handleMessage(message);
                    } catch (error) {
                        console.error("Failed to parse WebSocket message:", error);
                    }
                };

                this.ws.onclose = (event) => {
                    this.connected = false;
                    this.stopHeartbeat();
                    this.isReconnecting = false;
                    this.emit("disconnected", { code: event.code, reason: event.reason });

                    if (!this.isManualDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.attemptReconnect();
                    } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                        this.emit("reconnect_failed", { attempts: this.reconnectAttempts });
                    }
                };

                this.ws.onerror = (error) => {
                    this.emit("error", { error });
                    reject(error);
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    disconnect(): void {
        this.isManualDisconnect = true;
        this.isReconnecting = false;
        this.cleanupConnection();
    }

    private cleanupConnection(): void {
        this.stopHeartbeat();
        this.connected = false;
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(1000, "Client disconnect");
            }
            this.ws = null;
        }
    }

    send(type: string, data: any): void {
        if (!this.connected || !this.ws) return;
        try {
            this.ws.send(JSON.stringify({ type, data }));
        } catch (error) {
            console.error("Failed to send WebSocket message:", error);
        }
    }

    private register(): void {
        this.send("register", { type: this.clientInfo.type, name: this.clientInfo.name });
    }

    private handleMessage(message: WebSocketMessage): void {
        switch (message.type) {
            case "connection":
                this.clientInfo.id = message.data.clientId;
                break;
            case "register_success":
                console.log("WebSocket registered:", message.data);
                break;
            case "heartbeat_response":
                break;
            case "error":
                console.error("Server error:", message.data);
                this.emit("error", message.data);
                break;
            default:
                this.emit(message.type, message.data);
                break;
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatInterval = window.setInterval(() => {
            if (this.connected) this.send("heartbeat", { timestamp: Date.now() });
        }, 15000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    private attemptReconnect(): void {
        if (this.isReconnecting || this.isManualDisconnect) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;
        console.log(`WebSocket reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
        setTimeout(() => {
            this.connect().catch(() => {});
        }, this.reconnectDelay);
    }

    private resetReconnectState(): void {
        this.reconnectAttempts = 0;
        this.isManualDisconnect = false;
        this.isReconnecting = false;
    }

    on(event: string, handler: WebSocketEventHandler): void {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event)!.push(handler);
    }

    off(event: string, handler?: WebSocketEventHandler): void {
        if (!this.eventHandlers.has(event)) return;
        if (handler) {
            const handlers = this.eventHandlers.get(event)!;
            const index = handlers.indexOf(handler);
            if (index > -1) handlers.splice(index, 1);
        } else {
            this.eventHandlers.delete(event);
        }
    }

    private emit(event: string, data: any): void {
        this.eventHandlers.get(event)?.forEach((handler) => {
            try {
                handler(data);
            } catch (error) {
                console.error(`WebSocket event handler error (${event}):`, error);
            }
        });
    }

    isWebSocketConnected(): boolean {
        return this.connected;
    }

    getClientInfo(): ClientInfo {
        return { ...this.clientInfo };
    }

    sendRobotState(stateData: RobotStateData): void {
        this.send("robot_state", stateData);
    }

    sendJointControl(controlData: JointControlData): void {
        this.send("joint_control", controlData);
    }

    requestClientsList(): void {
        this.send("get_clients", { sourceClientId: this.clientInfo.id });
    }

    emergencyStop(): void {
        this.send("emergency_stop", {
            sourceClientId: this.clientInfo.id,
            timestamp: Date.now(),
        });
    }

    resetRobot(): void {
        this.send("reset_robot", { sourceClientId: this.clientInfo.id });
    }

    requestTestSequence(): void {
        this.send("test_sequence_request", { clientId: this.clientInfo.id });
    }

    stopTestSequence(): void {
        this.send("stop_sequence_request", { clientId: this.clientInfo.id });
    }

    async reconnect(): Promise<void> {
        this.resetReconnectState();
        return this.connect();
    }
}
