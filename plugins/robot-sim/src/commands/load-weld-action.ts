// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AsyncController,
    command,
    type I18nKeys,
    type IApplication,
    type ICommand,
    type IEdge,
    PubSub,
    ShapeTypes,
} from "@chili3d/core";
import type { WeldLineAction } from "../core/joint-config";
import { getRobotArm } from "../core/robot-registry";

@command({
    key: "robot.loadWeldAction" as any,
    icon: {
        type: "path",
        value: "icons/robot.svg",
    },
})
export class LoadWeldActionCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const doc = application.activeView?.document;
        const robotArm = getRobotArm(doc);

        if (!doc) {
            PubSub.default.pub("showToast", "robot.toast.noDocument" as I18nKeys);
            return;
        }

        if (!robotArm) {
            PubSub.default.pub("showToast", "robot.toast.noRobot" as I18nKeys);
            return;
        }

        // Prompt user to pick an edge (line)
        const controller = new AsyncController();
        doc.selection.shapeType = ShapeTypes.edge;

        let shapes;
        try {
            shapes = await doc.selection.pickShape("robot.toast.weldPickEdge" as I18nKeys, controller, false);
        } catch {
            return;
        }

        if (!shapes || shapes.length === 0) {
            return;
        }

        const shapeData = shapes[0];
        const edge = shapeData.shape.transformedMul(shapeData.transform) as IEdge;
        const startPt = edge.curve.startPoint();
        const endPt = edge.curve.endPoint();

        const action: WeldLineAction = {
            meta: {
                version: "1.0",
                description: "Weld line from picked edge",
                created: new Date().toISOString(),
                robot_type: robotArm.getModelConfigRef()?.modelId ?? "unknown",
                action_type: "weld_line",
            },
            weld: {
                start: [startPt.x, startPt.y, startPt.z],
                end: [endPt.x, endPt.y, endPt.z],
                speed: 50,
                steps: 60,
            },
        };

        // Notify control panel that a weld action is ready (but don't execute yet)
        PubSub.default.pub("weldActionReady" as any, action);
        PubSub.default.pub("showToast", "robot.toast.weldLoaded" as I18nKeys);
    }
}
