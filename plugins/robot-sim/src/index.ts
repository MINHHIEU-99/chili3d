// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys, Plugin } from "@chili3d/core";
import { ImportRobotCommand } from "./commands/import-robot";
import { LoadWeldActionCommand } from "./commands/load-weld-action";
import { OpenControlPanelCommand } from "./commands/open-control-panel";
import { RobotMoveCommand } from "./commands/robot-move";
import { RobotRotateCommand } from "./commands/robot-rotate";

const RobotSimPlugin: Plugin = {
    commands: [
        ImportRobotCommand,
        OpenControlPanelCommand,
        RobotMoveCommand,
        RobotRotateCommand,
        LoadWeldActionCommand,
    ],
    ribbons: [
        {
            tabName: "ribbon.tab.tools",
            groups: [
                {
                    groupName: "robot.group" as any,
                    items: [
                        "robot.import" as CommandKeys,
                        "robot.controlPanel" as CommandKeys,
                        "robot.loadWeldAction" as CommandKeys,
                    ],
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
                "command.robot.loadWeldAction": "Weld Line",
                "robot.toast.weldRunning": "A weld action is already running",
                "robot.toast.weldInvalidJson": "Invalid JSON file",
                "robot.toast.weldInvalidFormat":
                    "Invalid weld action format (requires meta.action_type: weld_line)",
                "robot.toast.weldPickEdge": "Click to select a line/edge to weld",
                "robot.toast.weldLoaded": "Weld line loaded. Press Play in Robot Control panel to start.",
                "robot.toast.weldStarted": "Weld line simulation started",
                "robot.toast.weldCompleted": "Weld line simulation completed",
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
                "command.robot.loadWeldAction": "焊接直线",
                "robot.toast.weldRunning": "焊接动作正在执行中",
                "robot.toast.weldInvalidJson": "无效的JSON文件",
                "robot.toast.weldInvalidFormat": "无效的焊接动作格式（需要 meta.action_type: weld_line）",
                "robot.toast.weldPickEdge": "点击选择要焊接的直线/边",
                "robot.toast.weldLoaded": "焊接直线已加载，在机器人控制面板点击 Play 开始。",
                "robot.toast.weldStarted": "焊接直线仿真已开始",
                "robot.toast.weldCompleted": "焊接直线仿真已完成",
            },
        } as any,
    ],
};

export default RobotSimPlugin;
