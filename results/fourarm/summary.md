# 4-arm 채점 요약 (k=10 평가 · Gold 7941144c · conditions 83d5b8a0)

arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | 치명 | 경미 | 미해결 | coarse | p95(ms) | RSS(MB)
---|---|---|---|---|---|---|---|---|---|---|---|---
B | 0.479 | 0.5944 | 0.6713 | 0.584 | 0.6667 | 11/19 | 0 | 17 | 0 | 99 | 22739 | 1423.0
D | 0.486 | 0.5909 | 0.6678 | 0.584 | 0.6389 | 9/19 | 0 | 13 | 0 | 103 | 4077 | 1260.2

## 판정: PROVISIONAL_WINNER → B (PERFORMANCE_WINNER)

```json
[
 {
  "step": "14 locator checked",
  "unchecked": []
 },
 {
  "step": "20 pins",
  "bad": []
 },
 {
  "step": "16 unresolved",
  "counts": {
   "B": 0,
   "D": 0
  }
 },
 {
  "step": "12 hard gate",
  "critical": {
   "B": 0,
   "D": 0
  },
  "hard_safe": [
   "B",
   "D"
  ]
 },
 {
  "step": "12 quality gate",
  "best_all": 0.5944,
  "best_high": 0.584,
  "values": {
   "B": {
    "ALL": 0.5944,
    "HIGH": 0.584
   },
   "D": {
    "ALL": 0.5909,
    "HIGH": 0.584
   }
  },
  "passed": [
   "B",
   "D"
  ]
 },
 {
  "step": "2/5 LOW all_found@10",
  "counts": {
   "B": 11,
   "D": 9
  },
  "best": 11,
  "final_tie_set": [
   "B"
  ]
 },
 {
  "step": "winner",
  "winner": "B",
  "selection_type": "PERFORMANCE_WINNER",
  "status": "PROVISIONAL_WINNER"
 }
]
```
