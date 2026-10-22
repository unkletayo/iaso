# Failure analysis

Run analysed: SWE-bench Lite, 10 tasks, seed 42, `anthropic:claude-haiku-5-5`, prompt version `1.0.0`. Result: 7 of 10 resolved (95% confidence interval 40%-89%), graded by the official harness. Cost $1.02 in total. Run folder: `runs/bench-swebench-lite-anthropic-claude-haiku-5-5-seed42-n10/` (not committed).

## How this was done

For each unresolved task I read the issue the agent saw, the agent's plan and summary, its patch, the harness test output, and, only after the fact, the reference fix and the hidden test from the dataset. The agent never saw the reference fix or the hidden tests, and nothing below was fed back into a prompt. The reading is my judgement, and the sample is three tasks, so treat the causes as findings about these tasks, not as statistics.

## Summary

All three patches applied cleanly and fixed the problem the issue describes. All three failed because the hidden test asserts behaviour the issue never states. In none of them could an agent have known the expected behaviour from the issue text alone.

| Task                   | What the issue asks                                                  | What the hidden test also requires                                           | Cause                                    |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| `django__django-11283` | Stop a migration crashing with `IntegrityError` on duplicate rows.   | A specific warning printed to stdout, with the existing rows left untouched. | A design choice the issue does not state |
| `sympy__sympy-13437`   | `bell(n).limit(n, oo)` should be `oo`, not `bell(oo)`.               | `ValueError` for `bell(oo, x)`, `bell(-1)` and `bell(1/2)`.                  | Extra behaviour the issue never mentions |
| `sympy__sympy-21171`   | `_print_SingularityFunction` crashes on an unexpected `exp` keyword. | One exact LaTeX string for a power of a singularity function.                | An exact output format the issue omits   |

## django__django-11283

**Issue:** migration `auth.0011_update_proxy_permissions` fails with a duplicate-key `IntegrityError` for models recreated as a proxy.

**What the agent did:** it found the right root cause (a bulk `update(content_type=...)` collides with rows that already exist under the proxy's content type). Its fix moves group and user links onto the existing permission and then deletes the duplicate row. It wrote its own test, ran 115 related tests, and reported confidence `high`.

**What the reference does:** it wraps the update in a transaction, catches `IntegrityError`, and prints a warning, "A problem arose migrating proxy model permissions", telling the user to audit the permissions. It deletes nothing. The hidden test asserts that warning text.

**Cause:** the issue reports a crash and says nothing about what a correct migration should do instead. The agent chose to merge and delete; the maintainers chose to warn and leave the data alone. The test encodes the maintainers' choice.

**Worth noting beyond the score:** the agent's fix deletes rows in a data migration that runs on production databases, and the issue did not ask for that. The agent's own plan listed the risk. A human reviewer would reasonably want to know that choice was made. The agent reported `high` confidence and did not say it was choosing between two designs.

## sympy__sympy-13437

**Issue:** `bell(n).limit(n, oo)` returns `bell(oo)`; it should be `oo`.

**What the agent did:** added `if n is S.Infinity and k_sym is None: return S.Infinity` at the top of `bell.eval`. A one-line fix that does exactly what the issue says.

**What the reference does:** the same for `bell(oo)`, and also raises `ValueError` for `bell(oo, x)` (a Bell polynomial at infinity), for negative `n`, and for non-integer `n`. The hidden test asserts all of that, and replaces an old assertion that described the previous behaviour for negative numbers.

**Cause:** the test checks three behaviours that the issue does not mention, one of which reverses an existing test. The first failing assertion is `raises(ValueError, lambda: bell(oo, x))`, which printed `DID NOT RAISE`.

**Worth noting:** the agent restricted its fix to `k_sym is None` and left `bell(oo, x)` falling through silently to old behaviour. Asking "what should the neighbouring inputs do?" is a sound habit, but the answer here (raise `ValueError`) is a maintainer decision, not something the code or the issue reveals.

## sympy__sympy-21171

**Issue:** `_print_SingularityFunction()` got an unexpected keyword argument `exp` (raised when printing a beam's shear force).

**What the agent did:** added `exp=None` to the method, and wrapped the result as `\left({\left\langle x - 4 \right\rangle}^{5}\right)^{3}`. This copies the pattern of the neighbouring `_print_DiracDelta` in the same file. The crash is fixed, and this is essentially the reference fix.

**What the reference does:** the same signature change, but with a different string: `{\left({\langle x - 4 \rangle}^{5}\right)}^{3}`. The hidden test compares exact strings.

**Cause:** the issue asks for the crash to stop and does not define the LaTeX. Any valid rendering fails an exact-string test unless it matches the reference character for character. Following the nearby code's style, as the agent did, is the sensible default and still fails.

## What this says about the agent

- **No sign of a wrong root cause or a broken patch in these three.** Each diagnosis matches the reference's.
- **The gap is in the tasks, not only the agent.** SWE-bench Lite tests were written for the maintainers' pull requests, not from the issue. I recall that the SWE-bench Verified subset was made by human review to keep only tasks whose issues are well specified and whose tests are fair; I have not re-checked that here. Running Verified would give a fairer read of the agent.
- **Confidence is not calibrated.** The agent reported `high` on all three. For a tool whose output a human reviews, the useful signal is the assumption it made, such as "I chose to delete rather than warn".

## Changes made

None. Prompt version is still `1.0.0`. With three failures, tuning the prompt toward them would mostly teach it these three tasks, and any change would need a larger sample to show it helps.

## Candidate changes (not applied)

Each should be tried on a larger sample, with the prompt version bumped, before it counts.

1. **Report assumptions.** Add an `assumptions` list to the `submit` tool, and ask the agent to name any place where the issue left the expected behaviour open. This does not raise the pass rate; it makes the patch easier for a human to judge. It would have surfaced the delete-versus-warn choice in `django-11283`.
2. **Prefer the least destructive behaviour** when the issue is silent about data. This might have chosen the warning in `django-11283`, but a single case is not evidence; test it before trusting it.
3. **Sweep neighbouring inputs** before submitting: for a special-cased value, list nearby inputs and state what each does. Unlikely to fix `sympy-13437` on its own, because the expected answer was a maintainer's decision.
4. **Measure on a larger and fairer sample:** a 50-task Lite run (about $5 at this rate), and a Verified sample to separate agent failures from unfair tests.

## Tracking

| Prompt version | Run                              | Resolved             | Notes                            |
| -------------- | -------------------------------- | -------------------- | -------------------------------- |
| 1.0.0          | 10-task Lite, seed 42, Haiku 5.5 | 7 of 10 (CI 40%-89%) | Baseline. No changes made after. |
