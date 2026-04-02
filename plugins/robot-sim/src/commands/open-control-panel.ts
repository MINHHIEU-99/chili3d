// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type I18nKeys, type IApplication, type ICommand, PubSub } from "@chili3d/core";
import { getRobotArm } from "../core/robot-registry";
import { RobotControlPanel } from "../ui/control-panel";

const PANEL_ID = "robot-control-panel";

@command({
    key: "robot.controlPanel" as any,
    icon: {
        type: "path",
        value: "icons/robot.svg",
    },
})
export class OpenControlPanelCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        if (document.getElementById(PANEL_ID)) {
            return;
        }

        const doc = application.activeView?.document;
        const robotArm = getRobotArm(doc);

        if (!robotArm) {
            PubSub.default.pub("showToast", "robot.toast.noRobot" as I18nKeys);
            return;
        }

        const panel = new RobotControlPanel(robotArm);
        const content = panel.render();
        content.id = PANEL_ID;

        PubSub.default.pub("showFloatPanel", {
            title: "robot.controlPanel.title" as I18nKeys,
            content,
            width: 360,
            height: 600,
            onClose: () => panel.dispose(),
        });
    }
}
