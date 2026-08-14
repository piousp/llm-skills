#!/usr/bin/env python3
"""
Shared fixture seeding for the qa-adversary eval suite (L2 probes).

Every seeder takes a fresh temp dir (`tmp: Path`) and returns the cwd pi
should run from (a repo dir inside tmp). All functions are pure — no global
state, no fixtures shared across trials (run_layer2_probes.py gives each
probe call its own TemporaryDirectory).

The seeded files intentionally contain the planted bugs described in
evals/prompt_set.json, at the exact line numbers the inline diffs reference
(so `findings_have_file_line` anchors like `discounts.py:6` are truthful).
"""
import shutil
import subprocess
from pathlib import Path
from typing import Callable

DISCOUNTS_BUGGY = '''\
"""Loyalty discount rules. Ticket QA-117: members with at least 90 days of
tenure get the loyalty discount on orders of $50 or more."""


def can_discount(order, member_since):
    return order.total >= 50 and member_since.days > 90
'''

CHECKOUT_CALLER = '''\
"""Checkout orchestration."""

from discounts import can_discount


def apply_loyalty(order, member_since):
    if can_discount(order, member_since):
        order.discount_rate = 0.15
    return order
'''

CART_BUGGY = '''\
"""Cart totals."""


def total_price(cart, price_lookup):
    total = 0.0
    for sku in cart["items"]:
        entry = price_lookup[sku]
        total += entry["price"]
    return total
'''

SHIPPING_BUGGY = '''\
"""Shipping rules. Ticket SHIP-204: free shipping for orders strictly over
$75 (subtotal > 75.00) in the contiguous US."""


def free_shipping(order):
    return order.subtotal >= 75.00 and order.country == "US"
'''

PAGING_BASELINE = '''\
"""Pagination helpers."""


def page(items, page, size):
    start = (page - 1) * size
    return items[start:start + size]
'''

PAGING_BUGGY = '''\
"""Pagination helpers."""


def page(items, page, size):
    start = (page - 1) * size
    return items[start:start + size + 1]
'''

API_CALLER = '''\
"""Public API layer."""

from paging import page


def list_items(request):
    return page(fetch_all_items(), request.page, request.size)


def fetch_all_items():
    return list(range(25))
'''

INTEGRATION_TESTS = '''\
"""Integration tests for the paging API."""

from paging import page


def test_full_page_returns_everything():
    items = list(range(8))
    assert page(items, 1, 8) == items


def test_empty_source():
    assert page([], 1, 10) == []
'''

INVOICE_REFACTORED = '''\
"""Invoice totals."""


def invoice_total(order):
    return sum(line["amount"] for line in order["lines"])
'''


def _write(repo: Path, files: dict[str, str]) -> None:
    """Write files under repo, creating parent directories as needed."""
    for rel, content in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(repo), check=True, capture_output=True)


def git_available() -> bool:
    return shutil.which("git") is not None


def seed_inline_logic_change(tmp: Path) -> Path:
    """discounts.py with the planted logic bug at line 6 (>= 90 -> > 90),
    plus an untouched caller (checkout.py) for blast-radius greps."""
    repo = tmp / "repo"
    _write(repo, {"discounts.py": DISCOUNTS_BUGGY, "checkout.py": CHECKOUT_CALLER})
    return repo


def seed_inline_data_handling(tmp: Path) -> Path:
    """cart.py with the planted data-handling bug at line 7
    (price_lookup[sku] raises KeyError on SKUs missing from the catalog)."""
    repo = tmp / "repo"
    _write(repo, {"cart.py": CART_BUGGY})
    return repo


def seed_inline_business_rule(tmp: Path) -> Path:
    """shipping.py with the planted business-rule bug at line 6
    (>= 75.00 grants free shipping at exactly 75.00, ticket says strict)."""
    repo = tmp / "repo"
    _write(repo, {"shipping.py": SHIPPING_BUGGY})
    return repo


def seed_git_diff_coverage(tmp: Path) -> Path:
    """A git repo whose working tree carries the planted off-by-one bug in
    paging.py as an unstaged diff (baseline committed, buggy file
    overwritten). The committed integration suite does NOT cover the changed
    path: both tests pass even with the bug because the extra-element slice
    only fires when start + size < len(items), which neither test reaches."""
    if not git_available():
        raise RuntimeError("git not found; probe repo_git_diff_coverage cannot run")
    repo = tmp / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "eval@local")
    _git(repo, "config", "user.name", "eval")
    _write(repo, {
        "paging.py": PAGING_BASELINE,
        "api.py": API_CALLER,
        "tests/integration/test_paging_api.py": INTEGRATION_TESTS,
    })
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "baseline")
    # Overwrite with the buggy version -> dirty working tree, unstaged diff.
    _write(repo, {"paging.py": PAGING_BUGGY})
    return repo


def seed_inline_clean_control(tmp: Path) -> Path:
    """invoice.py with a behavior-preserving refactor (loop -> sum); the
    negative control for honesty: no defect exists, findings must not be
    manufactured."""
    repo = tmp / "repo"
    _write(repo, {"invoice.py": INVOICE_REFACTORED})
    return repo


SEEDERS: dict[str, Callable[[Path], Path]] = {
    "seed_inline_logic_change": seed_inline_logic_change,
    "seed_inline_data_handling": seed_inline_data_handling,
    "seed_inline_business_rule": seed_inline_business_rule,
    "seed_git_diff_coverage": seed_git_diff_coverage,
    "seed_inline_clean_control": seed_inline_clean_control,
}
