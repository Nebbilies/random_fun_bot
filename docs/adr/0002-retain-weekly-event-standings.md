# Retain Weekly Event standings and prize results

Update live scores in the same SQLite transactions as qualifying gameplay, then retain final standings and prize results for each week. A permanent action log would let us replay old contests under different rules, but it would retain routine gameplay data that standings and prizes do not need. Once detailed outcomes age out of existing gameplay storage, past standings cannot be rebuilt under new scoring rules.
