// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CommandKeys,
    command,
    type I18nKeys,
    type IApplication,
    type ICommand,
    PubSub,
} from "@chili3d/core";
import * as THREE from "three";
import armConfig from "../configs/arm.json";
import cantileverConfig from "../configs/cantilever.json";
import type { RobotModelConfig } from "../core/joint-config";
import { RobotArm } from "../core/robot-arm";
import { getRobotArm, registerRobotArm, removeRobotArm } from "../core/robot-registry";

function detectModelConfig(filename: string): RobotModelConfig {
    const lower = filename.toLowerCase();
    if (lower.includes("cantilever")) return cantileverConfig as RobotModelConfig;
    return armConfig as RobotModelConfig;
}

const clickCleanups = new Map<string, () => void>();

function getContext(application: IApplication) {
    const view = application.activeView;
    const document = view?.document;
    if (!document || !view) return undefined;
    const visual = document.visual as any;
    return { document, view, scene: visual.scene as import("three").Scene };
}

function setupClickDetection(view: any, robotArm: RobotArm, docId: string) {
    // Clean up previous handler for this document
    clickCleanups.get(docId)?.();

    const dom = view.dom as HTMLElement | undefined;
    if (!dom) return;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos: { x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
        if (event.button === 0) {
            downPos = { x: event.clientX, y: event.clientY };
        }
    };

    const onPointerUp = (event: PointerEvent) => {
        if (event.button !== 0 || !downPos) return;

        // If the pointer moved more than 5px, it's a drag, not a click
        const dx = event.clientX - downPos.x;
        const dy = event.clientY - downPos.y;
        downPos = null;
        if (dx * dx + dy * dy > 25) return;

        // Use the current camera (not a stale reference)
        const camera = view.camera as THREE.Camera;
        if (!camera) {
            console.warn("[RobotSim] No camera found");
            return;
        }

        const rect = dom.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 - 1;

        raycaster.setFromCamera(pointer, camera);

        const targets = robotArm.getRaycastTargets();
        console.log(
            "[RobotSim] Click detected, targets:",
            targets.length,
            "pointer:",
            pointer.x.toFixed(3),
            pointer.y.toFixed(3),
        );

        if (targets.length === 0) return;

        // Ensure world matrices are up-to-date for raycasting
        for (const t of targets) {
            t.updateWorldMatrix(true, false);
        }

        const intersects = raycaster.intersectObjects(targets, false);
        console.log("[RobotSim] Intersections:", intersects.length);

        if (intersects.length > 0) {
            PubSub.default.pub("executeCommand", "robot.controlPanel" as CommandKeys);
        }
    };

    console.log("[RobotSim] Click detection set up on", dom.tagName, dom.className);
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointerup", onPointerUp);

    const cleanup = () => {
        dom.removeEventListener("pointerdown", onPointerDown);
        dom.removeEventListener("pointerup", onPointerUp);
        clickCleanups.delete(docId);
    };
    clickCleanups.set(docId, cleanup);
}

@command({
    key: "robot.import" as any,
    icon: {
        type: "path",
        value: "icons/robot.svg",
    },
})
export class ImportRobotCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const ctx = getContext(application);
        if (!ctx) {
            PubSub.default.pub("showToast", "robot.toast.noDocument" as I18nKeys);
            return;
        }

        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".glb,.gltf";

        const file = await new Promise<File | null>((resolve) => {
            input.addEventListener("change", () => {
                resolve(input.files?.[0] ?? null);
            });
            input.addEventListener("cancel", () => resolve(null));
            input.click();
        });

        if (!file) return;

        // Remove existing robot if any
        const existing = getRobotArm(ctx.document);
        if (existing) {
            clickCleanups.get(ctx.document.id)?.();
            removeRobotArm(ctx.document);
        }

        const modelConfig = detectModelConfig(file.name);
        console.log(`[RobotSim] Detected model config: ${modelConfig.modelId} for file: ${file.name}`);
        const robotArm = new RobotArm(ctx.scene, modelConfig);

        try {
            await robotArm.loadModelFromFile(file);
            robotArm.setOnSceneChanged(() => ctx.view.update());
            registerRobotArm(ctx.document, robotArm);

            // Set up click detection on the robot
            setupClickDetection(ctx.view, robotArm, ctx.document.id);

            PubSub.default.pub("showToast", "robot.toast.imported" as I18nKeys);
        } catch (error) {
            console.error("Failed to load robot model:", error);
            PubSub.default.pub("showToast", "robot.toast.importFailed" as I18nKeys);
            robotArm.dispose();
        }
    }
}
