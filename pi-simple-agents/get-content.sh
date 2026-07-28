#!/bin/bash
echo "=== src/agents.ts ==="
wc -l src/agents.ts
echo "=== test/unit/agents.test.ts ==="
wc -l test/unit/agents.test.ts
head -100 test/unit/agents.test.ts