# DRIVERFLOW — AGENT SAFETY RULES

This project contains critical production systems.

AI agents must follow these rules strictly.

## FROZEN SYSTEMS (DO NOT MODIFY)

The following files and systems are frozen and cannot be modified unless explicitly authorized by the project owner.

- lazy_matching.js (Phase 6 Core)
- matching score algorithm
- exclusivity timer logic (72h + extensions)
- ticket generation logic
- database schema
- production migrations
- payment logic
- match resolution flow (/api/matches/:id/resolve) (including PUSH logic)
- push notification system (MATCH FLOW)
- `sendPush(...)` function
- `notifications_service.js` (including Firebase Admin initialization)
- `/matches/:id/updateMatchStatus` (push triggers)
- `/driver/confirm-share` (post-commit push logic)
- `/company/confirm-share` (post-commit push logic)
- `lazy_matching.js` (push section)
- `push_tokens` table schema and indices

All Phase 6 components and PUSH NOTIFICATION MATCH FLOW are officially FROZEN as of 2026-03-20.
COMMIT → PUSH order is a non-negotiable rule.

Agents must NEVER modify these systems automatically.

## REQUIRED WORKFLOW

Before making any code change the agent MUST:

1. Explain the problem.
2. Identify the exact file to modify.
3. Explain the impact of the change.
4. Wait for explicit approval.

The agent must NOT execute changes automatically.

## DATABASE RULES

The agent must NEVER:

- create new columns
- delete columns
- modify schema
- run migrations

Database changes require explicit human approval.

## MATCHING ENGINE PROTECTION

The matching engine is a critical system.

Files protected:

- lazy_matching.js

The agent must never change matching logic, scoring rules, or candidate generation without explicit authorization.

## DEPLOYMENT RULES

Agents must never:

- deploy automatically
- modify production environment
- run destructive commands

All deployment actions must be approved.

## SAFE MODE

If the agent detects a task that requires modifying a frozen system, it must STOP and request human approval before proceeding.