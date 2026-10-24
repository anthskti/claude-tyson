# Claude Tyson v3 — SpacetimeDB schema (design)

Import the following Mermaid through Excalidraw's Mermaid-to-Excalidraw feature. PK = primary key; FK = foreign key. Some relationships (fighter slot, bot opponent) are application-enforced.

```mermaid
erDiagram
    PLAYER {
        string playerId PK
        string displayName
        float skillEstimate01
        json learnedStyle
        int matchesPlayed
    }
    MATCH {
        string matchId PK
        string fighterAPlayerId FK
        string fighterBPlayerId FK
        string botId
        string mode
        string status
        string winner
        string endReason
    }
    FIGHTER_STATE {
        string matchId FK
        string slot
        string playerId FK
        float health
        string state
        string dodgeDirection
    }
    COMBAT_EVENT {
        string eventId PK
        string matchId FK
        string kind
        string attackId
        string result
        float damage
    }
    MATCH_RESULT {
        string matchId PK,FK
        string winner
        json fighterAStats
        json fighterBStats
    }
    BOT_BALANCE {
        string matchId PK,FK
        float playerSkill01
        float targetChallenge01
        float aggression01
        int reactionDelayMs
    }
    STRATEGY {
        string strategyId PK
        string matchId FK
        json patch
        string hypothesis
    }
    ANALYSIS {
        string matchId FK
        string playerId FK
        string summary
        string nextSessionFocus
    }
    PLAYER ||--o{ MATCH : "fighter A (and optionally B)"
    MATCH ||--|{ FIGHTER_STATE : "two slots a/b"
    PLAYER o|--o{ FIGHTER_STATE : "human slot"
    MATCH ||--o{ COMBAT_EVENT : produces
    MATCH ||--o| MATCH_RESULT : finishes_with
    MATCH ||--o| BOT_BALANCE : "AI mode only"
    MATCH ||--o{ STRATEGY : "AI mode only"
    MATCH ||--o{ ANALYSIS : "per human participant"
    PLAYER ||--o{ ANALYSIS : receives
```

## Client-to-server pipeline

```mermaid
flowchart LR
    MP[MediaPipe landmarks] --> C[Client classifier]
    C --> M[MotionEvent]
    M --> V[SpacetimeDB submitMotion reducer]
    V --> R[Validate identity, timing, cooldown]
    R --> E[Authoritative combat engine]
    AI[Bot policy] --> E
    E --> CE[CombatEvent]
    E --> FS[FighterState]
    FS --> S[Subscribed client renderers]
    CE --> ST[Stats / history]
    ST --> CLAUDE[Claude strategy + post-fight analysis]
    CLAUDE --> AI
```
