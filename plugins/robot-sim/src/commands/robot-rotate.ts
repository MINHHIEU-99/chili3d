// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    Matrix4,
    PubSub,
    Transaction,
    VisualNode,
} from "@chili3d/core";
import { getRobotArm } from "../core/robot-registry";

/** Checks whether the selected nodes belong to a loaded robot arm */
function getSelectedRobotNodes(application: IApplication): VisualNode[] | null {
    const doc = application.activeView?.document;
    if (!doc) return null;
    const robotArm = getRobotArm(doc);
    if (!robotArm) return null;

    const selected = doc.selection.getSelectedNodes();
    if (selected.length === 0) return null;

    const hasRobotNode = selected.some((n) => {
        const parent = (n as any).parent;
        return parent && parent.name === robotArm.getModelConfigRef()?.displayName;
    });

    if (!hasRobotNode) return null;
    return selected.filter((x) => x instanceof VisualNode);
}

@command({
    key: "modify.rotate",
    icon: "icon-rotate",
})
export class RobotRotateCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const robotNodes = getSelectedRobotNodes(application);
        if (robotNodes && robotNodes.length > 0) {
            // Import createRobotDualGizmos dynamically to avoid circular dependency
            const { createRobotDualGizmos } = await import("./robot-move");
            try {
                await createRobotDualGizmos(application, "rotate");
            } catch {
                // User cancelled
            }
            return;
        }

        // Fall back to default rotate behavior for non-robot selections
        const doc = application.activeView?.document;
        if (!doc) return;

        const models = doc.selection.getSelectedNodes().filter((x) => x instanceof VisualNode);
        if (models.length === 0) {
            PubSub.default.pub("showToast", "toast.select.noSelected");
            return;
        }

        const view = application.activeView;
        if (!view) return;

        const gizmo = view.createTransformGizmo?.(models, "rotate");
        if (!gizmo) return;

        try {
            PubSub.default.pub("statusBarTip", "prompt.pickNextPoint");
            const transform = await gizmo.waitForResult();
            if (!transform.equals(Matrix4.identity())) {
                Transaction.execute(doc, "excute Rotate", () => {
                    models.forEach((x) => {
                        x.transform = x.transform.multiply(transform);
                    });
                    doc.visual.update();
                });
            }
        } catch {
            // cancelled
        } finally {
            gizmo.dispose();
        }
    }
}
