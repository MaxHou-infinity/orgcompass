#!/usr/bin/env python3
"""
V2.4.0 真实 UI 测试统一入口（交互 + 视觉回归）。

    python3 tests/e2e/run.py              # 跑全部
    python3 tests/e2e/run.py interaction  # 只跑交互
    python3 tests/e2e/run.py visual       # 只跑视觉回归

前置：`npm run tauri:dev`（或 `npm run dev`）已在 http://localhost:5173 运行。
单元/组件测试与工程门禁不在这里，走 `npm run verify`（见 README）。
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

SUITES = {
    "interaction": [
        ("虚拟员工兼岗流程", "test_interaction_virtual"),
        ("岗位与编制子界面", "test_interaction_board"),
        ("部门删除与归属限制", "test_interaction_dept"),
        ("三个子页面一致性", "test_interaction_pages"),
    ],
    "visual": [
        ("视觉回归（几何断言）", "test_visual_v240"),
    ],
}


def main(argv: list[str]) -> int:
    which = argv[1] if len(argv) > 1 else "all"
    if which not in ("all", "interaction", "visual"):
        print(f"未知套件：{which}（可选 all / interaction / visual）")
        return 2
    groups = ["interaction", "visual"] if which == "all" else [which]

    codes: list[tuple[str, int]] = []
    for group in groups:
        for title, module_name in SUITES[group]:
            print(f"\n{'#' * 66}\n# {title}  ({module_name}.py)\n{'#' * 66}")
            mod = importlib.import_module(module_name)
            importlib.reload(mod)
            codes.append((title, mod.run()))

    print(f"\n{'=' * 66}\n汇总")
    failed = 0
    for title, code in codes:
        print(f"  {'✓ 通过' if code == 0 else '✗ 失败'}  {title}")
        failed += 1 if code else 0
    print("=" * 66)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
