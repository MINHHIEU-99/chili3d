// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import * as THREE from "three";

export interface TrajectoryPoint {
    position: THREE.Vector3;
    time: number;
    frameId: number;
}

export interface TrajectoryConfig {
    visible: boolean;
    lineColor: string;
    startPointColor: string;
    endPointColor: string;
    lineWidth: number;
    nodeSize: number;
}

export class TrajectoryVisualizer {
    private trajectoryPoints: TrajectoryPoint[] = [];
    private currentDrawnPoints: number = 0;
    private lineGeometry: THREE.BufferGeometry | null = null;
    private lineMaterial: THREE.LineDashedMaterial | null = null;
    private line: THREE.Line | null = null;
    private startNode: THREE.Mesh | null = null;
    private endNode: THREE.Mesh | null = null;
    private startNodeMaterial: THREE.MeshBasicMaterial | null = null;
    private endNodeMaterial: THREE.MeshBasicMaterial | null = null;
    private isFirstPlay: boolean = true;
    private currentSequenceId: string | null = null;

    private config: TrajectoryConfig = {
        visible: true,
        lineColor: "#00ff00",
        startPointColor: "#0000ff",
        endPointColor: "#ff0000",
        lineWidth: 2,
        nodeSize: 0.01,
    };

    constructor(private scene: THREE.Scene) {}

    setConfig(config: Partial<TrajectoryConfig>): void {
        const oldConfig = { ...this.config };
        this.config = { ...this.config, ...config };

        if (oldConfig.visible !== this.config.visible) {
            this.updateVisibility();
        }
        if (oldConfig.lineColor !== this.config.lineColor && this.lineMaterial) {
            this.lineMaterial.color.set(this.config.lineColor);
        }
        if (oldConfig.startPointColor !== this.config.startPointColor && this.startNodeMaterial) {
            this.startNodeMaterial.color.set(this.config.startPointColor);
        }
        if (oldConfig.endPointColor !== this.config.endPointColor && this.endNodeMaterial) {
            this.endNodeMaterial.color.set(this.config.endPointColor);
        }
    }

    getConfig(): TrajectoryConfig {
        return { ...this.config };
    }

    startNewTrajectory(sequenceId: string): void {
        const isNewSequence = this.currentSequenceId !== sequenceId;
        const trajectoryCleared = this.trajectoryPoints.length === 0;

        if (isNewSequence) {
            this.clear();
            this.isFirstPlay = true;
            this.currentSequenceId = sequenceId;
        } else if (trajectoryCleared) {
            this.isFirstPlay = true;
        } else {
            this.isFirstPlay = false;
        }

        this.currentDrawnPoints = 0;

        if (!this.isFirstPlay && this.trajectoryPoints.length > 0) {
            this.drawCompleteTrajectory();
        }
    }

    addTrajectoryPoint(point: TrajectoryPoint): void {
        this.trajectoryPoints.push(point);
        if (this.isFirstPlay) {
            this.updateIncrementalTrajectory();
        }
    }

    private updateIncrementalTrajectory(): void {
        if (!this.config.visible) return;
        const pointsCount = this.trajectoryPoints.length;
        if (pointsCount < 2) return;
        this.updateLine();
        this.updateNodes();
        this.currentDrawnPoints = pointsCount;
    }

    private drawCompleteTrajectory(): void {
        if (!this.config.visible || this.trajectoryPoints.length < 2) return;
        this.currentDrawnPoints = this.trajectoryPoints.length;
        this.updateLine();
        this.updateNodes();
    }

    private updateLine(): void {
        if (this.line) {
            this.scene.remove(this.line);
            this.lineGeometry?.dispose();
            this.lineMaterial?.dispose();
        }

        const points = this.trajectoryPoints.slice(0, this.currentDrawnPoints).map((p) => p.position);
        if (points.length < 2) return;

        this.lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        this.lineMaterial = new THREE.LineDashedMaterial({
            color: this.config.lineColor,
            linewidth: this.config.lineWidth,
            dashSize: 0.03,
            gapSize: 0.02,
        });

        this.line = new THREE.Line(this.lineGeometry, this.lineMaterial);
        this.line.computeLineDistances();
        this.line.visible = this.config.visible;
        this.scene.add(this.line);
    }

    private updateNodes(): void {
        const pointsCount = this.currentDrawnPoints;

        if (pointsCount > 0) {
            const startPoint = this.trajectoryPoints[0];
            if (!this.startNode) {
                const { mesh, material } = this.createNodeWithMaterial(
                    startPoint.position,
                    this.config.startPointColor,
                );
                this.startNode = mesh;
                this.startNodeMaterial = material;
                this.scene.add(this.startNode);
            } else {
                this.startNode.position.copy(startPoint.position);
            }
        }

        if (pointsCount > 1) {
            const endPoint = this.trajectoryPoints[pointsCount - 1];
            if (!this.endNode) {
                const { mesh, material } = this.createNodeWithMaterial(
                    endPoint.position,
                    this.config.endPointColor,
                );
                this.endNode = mesh;
                this.endNodeMaterial = material;
                this.scene.add(this.endNode);
            } else {
                this.endNode.position.copy(endPoint.position);
            }
        }
    }

    private createNodeWithMaterial(
        position: THREE.Vector3,
        color: string,
    ): { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial } {
        const geometry = new THREE.SphereGeometry(this.config.nodeSize, 16, 16);
        const material = new THREE.MeshBasicMaterial({ color });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(position);
        return { mesh, material };
    }

    private updateVisibility(): void {
        if (this.line) this.line.visible = this.config.visible;
        if (this.startNode) this.startNode.visible = this.config.visible;
        if (this.endNode) this.endNode.visible = this.config.visible;
    }

    setVisible(visible: boolean): void {
        this.config.visible = visible;
        this.updateVisibility();
    }

    finishTrajectory(): void {
        if (this.isFirstPlay && this.trajectoryPoints.length > 0) {
            this.isFirstPlay = false;
        }
    }

    clear(): void {
        if (this.line) {
            this.scene.remove(this.line);
            this.lineGeometry?.dispose();
            this.lineMaterial?.dispose();
            this.line = null;
            this.lineGeometry = null;
            this.lineMaterial = null;
        }
        if (this.startNode) {
            this.scene.remove(this.startNode);
            this.startNode.geometry.dispose();
            this.startNodeMaterial?.dispose();
            this.startNode = null;
            this.startNodeMaterial = null;
        }
        if (this.endNode) {
            this.scene.remove(this.endNode);
            this.endNode.geometry.dispose();
            this.endNodeMaterial?.dispose();
            this.endNode = null;
            this.endNodeMaterial = null;
        }
        this.trajectoryPoints = [];
        this.currentDrawnPoints = 0;
    }

    dispose(): void {
        this.clear();
        this.currentSequenceId = null;
    }

    static getEndEffectorPosition(robotModel: THREE.Group | null): THREE.Vector3 | null {
        if (!robotModel) return null;

        const endEffector = new THREE.Object3D();
        endEffector.position.setX(0.15);

        robotModel.traverse((child) => {
            if (child.name === "gripper_base") {
                child.add(endEffector);
            }
        });

        if (endEffector) {
            const worldPosition = new THREE.Vector3();
            endEffector.getWorldPosition(worldPosition);
            return worldPosition;
        }

        return null;
    }
}
