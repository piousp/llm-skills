#!/usr/bin/env python3
"""Fixture builders for the code-review-checklist Layer 2 eval.

Each builder takes the root of a fresh temp dir and returns a Fixture:

    Fixture = dict  # {"cwd": Path, "planted": dict[str, tuple[str, str]],
                     #  "test_files": list[str], "branch": str | None}

    - cwd:        directory `pi` should run from (the seeded git repo)
    - planted:    {defect_name: (token, file)} — tokens a correct review must
                  mention, files as referenced in the review output
    - test_files: test files the review is expected to read
    - branch:     branch name when the fixture models a feature branch

Builders write the base version and commit it, then write the working
version (unstaged), or `git add` it (staged fixture C), or commit on a
feature branch (fixture D). Tests are never executed — they are text.

Line numbers in the docstrings reference the final working file.
"""
import os
import subprocess
from pathlib import Path
from typing import Callable

Fixture = dict  # {"cwd": Path, "planted": dict[str, tuple[str | list[str], str]], "test_files": list[str], "branch": str | None}

_GIT_ENV = {
    "GIT_AUTHOR_NAME": "eval",
    "GIT_AUTHOR_EMAIL": "eval",
    "GIT_COMMITTER_NAME": "eval",
    "GIT_COMMITTER_EMAIL": "eval",
}

PACKAGE_JSON = (
    '{"name": "shop", "version": "1.0.0", "private": true, '
    '"scripts": {"test": "vitest run"}, "devDependencies": {"vitest": "^2.1.0"}}'
)

README_BASE = "# Shop\n\nRequires Node 18."
README_WORK = "# Shop\n\nRequires Node 20."

ORDERS_BASE = """export interface Order {
  id: string;
  items: string[];
  status: string;
}

export function discount(price: number, percent: number): number {
  return price * (1 - percent / 100);
}
"""

# A — work version of src/orders.ts: processOrders spans lines 11-35
# (25 lines with braces, cyclomatic 7, nesting 4), formatOrderLabel has
# a `verbose` boolean parameter at line 37-38.
ORDERS_WORK = """export interface Order {
  id: string;
  items: string[];
  status: string;
}

export function discount(price: number, percent: number): number {
  return price * (1 - percent / 100);
}

export function processOrders(orders: Order[]): string[] {
  const result: string[] = [];
  for (const order of orders) {
    if (order.status === "pending") {
      for (const item of order.items) {
        if (item.length > 2) {
          result.push(item);
        }
      }
    }
  }
  if (orders.length > 0) {
    result.push("batch-done");
  }
  if (result.length === 0) {
    result.push("empty");
  }
  if (result.length > 10) {
    result.push("large");
  }
  if (orders.some((o) => o.status === "cancelled")) {
    result.push("had-cancelled");
  }
  return result;
}

export function formatOrderLabel(order: Order, verbose: boolean): string {
  return verbose ? `${order.id} (${order.status})` : order.id;
}
"""

PAYMENTS_BASE = """export interface PaymentResult {
  ok: boolean;
  id?: string;
}

export async function chargeCard(userId: number): Promise<boolean> {
  return Promise.resolve(true);
}
"""

# A — work version of src/payments.ts: secret at line 6, `let client` at
# line 13, swallowed catch in chargeUser (catch 17-19, no log, no rethrow).
PAYMENTS_WORK = """export interface PaymentResult {
  ok: boolean;
  id?: string;
}

const PAYMENT_GATEWAY_KEY = "dev-gateway-key-7f3a91";

export async function chargeCard(userId: number): Promise<boolean> {
  return Promise.resolve(true);
}

export async function chargeUser(userId: number): Promise<PaymentResult> {
  let client = createClient();
  try {
    const ok = await chargeCard(userId);
    return { ok, id: client.id };
  } catch (e) {
    // swallowed: caller sees a failed payment with no reason
    return { ok: false };
  }
}

function createClient(): { id: string } {
  return { id: "cli_123" };
}
"""

PAYMENTS_C_BASE = """export function createPaymentIntent(amount: number): string {
  return "pi_" + amount;
}
"""

# C — staged version of src/payments.ts: secret at line 5, `let intent`
# at line 8.
PAYMENTS_C_WORK = """export function createPaymentIntent(amount: number): string {
  return "pi_" + amount;
}

const PAYMENT_GATEWAY_KEY = "dev-gateway-key-7f3a91";

export function confirmPayment(amount: number): string {
  let intent = createPaymentIntent(amount);
  return intent;
}
"""

ORDERS_TEST_BASE = """import { test, expect } from "vitest";
import { discount } from "../src/orders";

test("discount applies the percentage", () => {
  expect(discount(100, 10)).toBe(90);
});
"""

# B — clean work version of tests/orders.test.ts: a tests-only diff (no
# production change), asserting real behavior with explicit vitest imports.
ORDERS_TEST_B = """import { test, expect } from "vitest";
import { discount } from "../src/orders";

test("discount applies the percentage", () => {
  expect(discount(100, 10)).toBe(90);
});

test("discount with zero percent returns the original price", () => {
  expect(discount(100, 0)).toBe(100);
});

test("discount with 100 percent returns zero", () => {
  expect(discount(100, 100)).toBe(0);
});
"""

PAYMENTS_TEST_BASE = """import { test, expect } from "vitest";
import { chargeCard } from "../src/payments";

test("chargeCard resolves true", async () => {
  expect(await chargeCard(1)).toBe(true);
});
"""

# A — work version of tests/payments.test.ts: tautological test at lines 7-9
# (no expect, exercises no behavior).
PAYMENTS_TEST_WORK = """import { test, expect } from "vitest";
import { chargeCard, chargeUser } from "../src/payments";

test("chargeCard resolves true", async () => {
  expect(await chargeCard(1)).toBe(true);
});

test("chargeUser runs without throwing", async () => {
  await chargeUser(1);
});
"""

CONFIG_BASE = "export const MAX_RETRIES = 3;"
CONFIG_WORK = 'export const MAX_RETRIES = 3;\nexport const DATABASE_CREDENTIALS = "admin:change-me";'

BILLING_BASE = """export function invoiceTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
"""

LABELS_BASE = """export interface Label {
  name: string;
  email: string;
}
"""

# EN — work version of src/labels.ts: `verbose` boolean parameter at line 6,
# no test file exists for it.
LABELS_WORK = """export interface Label {
  name: string;
  email: string;
}

export function formatLabel(label: Label, verbose: boolean): string {
  return verbose ? `${label.name} <${label.email}>` : label.name;
}
"""

USER_BASE = """export interface User {
  id: number;
  name: string;
}

export function formatName(user: User): string {
  return user.name.trim();
}
"""

# NIT — work version of src/user.ts: a mechanical refactor of formatName
# that introduces exactly two nits — a snake_case local (`user_name`) and a
# redundant "what" comment. No new public API, so no YAGNI/duplication
# Major can apply; the change ships with its test.
USER_WORK = """export interface User {
  id: number;
  name: string;
}

export function formatName(user: User): string {
  const user_name = user.name.trim();
  // Returns the trimmed user name
  return user_name;
}
"""

USER_TEST_BASE = """import { test, expect } from "vitest";
import { formatName } from "../src/user";

test("formatName trims the name", () => {
  expect(formatName({ id: 1, name: "  Alice  " })).toBe("Alice");
});
"""

USER_TEST_WORK = """import { test, expect } from "vitest";
import { formatName } from "../src/user";

test("formatName trims the name", () => {
  expect(formatName({ id: 1, name: "  Alice  " })).toBe("Alice");
});

test("formatName handles an empty name", () => {
  expect(formatName({ id: 1, name: "  " })).toBe("");
});
"""

# D — commit 1 addition to src/orders.ts: `verbose` at line 11 of the
# final feature-branch file.
FORMAT_ORDER_LABEL_ADD = """export function formatOrderLabel(order: Order, verbose: boolean): string {
  return verbose ? `${order.id} (${order.status})` : order.id;
}
"""

# D — commit 2 addition to tests/orders.test.ts: covers the zero-percent
# branch of the *existing* discount function, never formatOrderLabel
# (that is the planted coverage gap).
ZERO_PERCENT_TEST = """test("discount handles zero percent", () => {
  expect(discount(100, 0)).toBe(100);
});
"""


def git(repo: Path, *args: str) -> None:
    """Run a git command in repo with eval identity (no global config needed)."""
    env = dict(os.environ)
    env.update(_GIT_ENV)
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True, env=env, capture_output=True, text=True,
    )


def git_init(repo: Path) -> None:
    """`git init -q -b main`; falls back to `git init -q` + checkout for
    git versions older than 2.28."""
    repo.mkdir(parents=True, exist_ok=True)
    try:
        git(repo, "init", "-q", "-b", "main")
    except subprocess.CalledProcessError:
        git(repo, "init", "-q")
        git(repo, "checkout", "-q", "-b", "main")


def commit_all(repo: Path, message: str) -> None:
    """git add -A + git commit -q -m <message>."""
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def write(path: Path, content: str) -> None:
    """mkdir -p parents, then write content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


# ---------------------------------------------------------------------------
# Fixture builders — one per prompt_set id.
# ---------------------------------------------------------------------------

def build_dirty_diff_unstaged(tmp: Path) -> Fixture:
    """A — unstaged working tree with 7 planted defects.

    git diff expected: {README.md, src/orders.ts, src/payments.ts,
    tests/payments.test.ts}.
    """
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "README.md", README_BASE)
    write(repo / "src/orders.ts", ORDERS_BASE)
    write(repo / "src/payments.ts", PAYMENTS_BASE)
    write(repo / "tests/payments.test.ts", PAYMENTS_TEST_BASE)
    write(repo / "tests/orders.test.ts", ORDERS_TEST_BASE)
    commit_all(repo, "base")
    # working tree (unstaged) changes
    write(repo / "README.md", README_WORK)
    write(repo / "src/orders.ts", ORDERS_WORK)
    write(repo / "src/payments.ts", PAYMENTS_WORK)
    write(repo / "tests/payments.test.ts", PAYMENTS_TEST_WORK)
    return {
        "cwd": repo,
        "planted": {
            "secret": (["dev-gateway-key-7f3a91", "PAYMENT_GATEWAY_KEY"], "payments.ts"),
            "mutable_let": ("let client", "payments.ts"),
            "swallowed_catch": ("chargeUser", "payments.ts"),
            "complexity": ("processOrders", "orders.ts"),
            "bool_param": ("verbose", "orders.ts"),
            "scope_violation": ("Node 20", "README.md"),
            "weak_test": ("without throwing", "payments.test.ts"),
        },
        "test_files": ["payments.test.ts", "orders.test.ts"],
        "branch": None,
    }


def build_clean_diff_all_pass(tmp: Path) -> Fixture:
    """B — tests-only unstaged change, defect-free; review must pass
    everything and return READY.

    git diff expected: {tests/orders.test.ts}.
    """
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/orders.ts", ORDERS_BASE)
    write(repo / "tests/orders.test.ts", ORDERS_TEST_BASE)
    commit_all(repo, "base")
    write(repo / "tests/orders.test.ts", ORDERS_TEST_B)
    return {
        "cwd": repo,
        "planted": {},
        "test_files": ["orders.test.ts"],
        "branch": None,
    }


def build_staged_diff_only(tmp: Path) -> Fixture:
    """C — only staged changes; working tree clean.

    git diff --cached: {src/payments.ts}; git diff: empty.
    """
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/payments.ts", PAYMENTS_C_BASE)
    commit_all(repo, "base")
    write(repo / "src/payments.ts", PAYMENTS_C_WORK)
    git(repo, "add", "src/payments.ts")
    return {
        "cwd": repo,
        "planted": {
            "secret": (["dev-gateway-key-7f3a91", "PAYMENT_GATEWAY_KEY"], "payments.ts"),
            "mutable_let": ("let intent", "payments.ts"),
        },
        "test_files": [],
        "branch": None,
    }


def build_feature_branch_diff(tmp: Path) -> Fixture:
    """D — feature branch with 2 commits against main; cwd stays on feature.

    git diff main...HEAD: {src/orders.ts, tests/orders.test.ts}.
    Coverage gap: formatOrderLabel added with no test.
    """
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/orders.ts", ORDERS_BASE)
    write(repo / "tests/orders.test.ts", ORDERS_TEST_BASE)
    commit_all(repo, "base")
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo / "src/orders.ts", ORDERS_BASE + "\n" + FORMAT_ORDER_LABEL_ADD)
    commit_all(repo, "feat: add formatOrderLabel")
    write(repo / "tests/orders.test.ts", ORDERS_TEST_BASE + "\n" + ZERO_PERCENT_TEST)
    commit_all(repo, "test: cover zero percent discount")
    return {
        "cwd": repo,
        "planted": {"bool_param": ("verbose", "orders.ts")},
        "test_files": ["orders.test.ts"],
        "branch": "feature",
    }


def build_single_blocker_needs_work(tmp: Path) -> Fixture:
    """E — one planted secret (a Blocker); nothing else.

    git diff expected: {src/config.ts}.
    """
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/config.ts", CONFIG_BASE)
    commit_all(repo, "base")
    write(repo / "src/config.ts", CONFIG_WORK)
    return {
        "cwd": repo,
        "planted": {"secret": (["admin:change-me", "DATABASE_CREDENTIALS"], "config.ts")},
        "test_files": [],
        "branch": None,
    }


def build_no_diff_graceful(tmp: Path) -> Fixture:
    """F — committed tree, clean working tree, no diff to review."""
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/orders.ts", ORDERS_BASE)
    commit_all(repo, "base")
    return {
        "cwd": repo,
        "planted": {},
        "test_files": [],
        "branch": None,
    }


def build_diff_handed_in_prompt(tmp: Path) -> Fixture:
    """G — repo clean; the diff under review is embedded in the prompt
    (self-contained, per SKILL.md Process step 1). billing.ts as committed
    does NOT contain the diff's additions."""
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/billing.ts", BILLING_BASE)
    commit_all(repo, "base")
    return {
        "cwd": repo,
        "planted": {
            "secret": (["dev-token-9d2b9f8e", "SOURCE_HOST_TOKEN"], "billing.ts"),
            "swallowed_catch": ("ignored", "billing.ts"),
        },
        "test_files": [],
        "branch": None,
    }


def build_negative_control(tmp: Path) -> Fixture:
    """NC — committed tree; prompt is a non-review question (queue vs stack)."""
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/orders.ts", ORDERS_BASE)
    commit_all(repo, "base")
    return {
        "cwd": repo,
        "planted": {},
        "test_files": [],
        "branch": None,
    }


def build_english_trigger_phrase(tmp: Path) -> Fixture:
    """EN — English trigger prompt; `verbose` bool param at line 6 of
    src/labels.ts, no test file at all (coverage gap)."""
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/labels.ts", LABELS_BASE)
    commit_all(repo, "base")
    write(repo / "src/labels.ts", LABELS_WORK)
    return {
        "cwd": repo,
        "planted": {"bool_param": ("verbose", "labels.ts")},
        "test_files": [],
        "branch": None,
    }


def build_nit_only_ready(tmp: Path) -> Fixture:
    """NIT — only two nits (snake_case local, redundant "what" comment);
    verdict should be READY. No new public API, so no YAGNI Major can
    apply; the refactor ships with its test."""
    repo = tmp / "repo"
    git_init(repo)
    write(repo / "package.json", PACKAGE_JSON)
    write(repo / "src/user.ts", USER_BASE)
    write(repo / "tests/user.test.ts", USER_TEST_BASE)
    commit_all(repo, "base")
    write(repo / "src/user.ts", USER_WORK)
    write(repo / "tests/user.test.ts", USER_TEST_WORK)
    return {
        "cwd": repo,
        "planted": {
            "naming_nit": ("user_name", "user.ts"),
            "redundant_comment": ("Returns the trimmed user name", "user.ts"),
        },
        "test_files": ["user.test.ts"],
        "branch": None,
    }


FIXTURE_BUILDERS: dict[str, Callable[[Path], Fixture]] = {
    "dirty_diff_unstaged": build_dirty_diff_unstaged,
    "clean_diff_all_pass": build_clean_diff_all_pass,
    "staged_diff_only": build_staged_diff_only,
    "feature_branch_diff": build_feature_branch_diff,
    "single_blocker_needs_work": build_single_blocker_needs_work,
    "no_diff_graceful": build_no_diff_graceful,
    "diff_handed_in_prompt": build_diff_handed_in_prompt,
    "negative_control": build_negative_control,
    "english_trigger_phrase": build_english_trigger_phrase,
    "nit_only_ready": build_nit_only_ready,
}
