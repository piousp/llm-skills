#!/bin/bash
echo "=== package.json test script ==="
node -e "const p = require('./package.json'); console.log('test:', p.scripts.test, 'type:', p.type)"
echo "=== test files ==="
find test -name "*.ts" -type f
echo "=== src files ==="
find src -name "*.ts" -type f
echo "=== AgentConfig in src/agents.ts ==="
grep -n "AgentConfig" src/agents.ts
echo "=== readOverridesFile in src/agents.ts ==="
grep -n "readOverridesFile\|agentOverrides\|pi-simple-agents\|subagents" src/agents.ts
echo "=== makeTmpDir in test ==="
grep -rn "makeTmpDir\|writeAgentFile" test/