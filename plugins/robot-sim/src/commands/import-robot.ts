// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type I18nKeys, type IApplication, type ICommand, PubSub } from "@chili3d/core";
import { RobotArm } from "../core/robot-arm";
import { getRobotArm, registerRobotArm, removeRobotArm } from "../core/robot-registry";

function getScene(application: IApplication) {
    const document = application.activeView?.document;
    if (!document) return undefined;
    // ThreeVisual exposes scene as a public readonly property
    const visual = document.visual as any;
    return { document, scene: visual.scene as import("three").Scene };
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
        const ctx = getScene(application);
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
            removeRobotArm(ctx.document);
        }

        const robotArm = new RobotArm(ctx.scene);

        try {
            await robotArm.loadModelFromFile(file);
            registerRobotArm(ctx.document, robotArm);
            PubSub.default.pub("showToast", "robot.toast.imported" as I18nKeys);
        } catch (error) {
            console.error("Failed to load robot model:", error);
            PubSub.default.pub("showToast", "robot.toast.importFailed" as I18nKeys);
            robotArm.dispose();
        }
    }
}
