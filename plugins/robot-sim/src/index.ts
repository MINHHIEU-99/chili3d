// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys, Plugin } from "@chili3d/core";
import { ImportRobotCommand } from "./commands/import-robot";
import { OpenControlPanelCommand } from "./commands/open-control-panel";
import { RobotMoveCommand } from "./commands/robot-move";
import { RobotRotateCommand } from "./commands/robot-rotate";

const RobotSimPlugin: Plugin = {
    commands: [ImportRobotCommand, OpenControlPanelCommand, RobotMoveCommand, RobotRotateCommand],
    ribbons: [
        {
            tabName: "ribbon.tab.tools",
            groups: [
                {
                    groupName: "robot.group" as any,
                    items: ["robot.import" as CommandKeys, "robot.controlPanel" as CommandKeys],
                },
            ],
        },
    ],
    i18nResources: [
        {
            language: "en",
            display: "English",
            translation: {
                "command.robot.import": "Import Robot",
                "command.robot.controlPanel": "Robot Control",
                "robot.group": "Robot Simulation",
                "robot.controlPanel.title": "Robot Arm Control",
                "robot.toast.noDocument": "Please open a document first",
                "robot.toast.noRobot": "Please import a robot model first (Import Robot)",
                "robot.toast.imported": "Robot model imported successfully",
                "robot.toast.importFailed": "Failed to import robot model",
            },
        } as any,
        {
            language: "zh-CN",
            display: "简体中文",
            translation: {
                "command.robot.import": "导入机器人",
                "command.robot.controlPanel": "机器人控制",
                "robot.group": "机器人仿真",
                "robot.controlPanel.title": "机械臂控制",
                "robot.toast.noDocument": "请先打开一个文档",
                "robot.toast.noRobot": "请先导入机器人模型（导入机器人）",
                "robot.toast.imported": "机器人模型导入成功",
                "robot.toast.importFailed": "机器人模型导入失败",
            },
        } as any,
    ],
};

export default RobotSimPlugin;
