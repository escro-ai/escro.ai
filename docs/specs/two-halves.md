# The two halves of agent payments

An agent pays another agent in one of two ways. Either the thing it buys comes back in the same call, and it pays
at the request; or the work takes time, and it locks the money at the request and lets it go only once the work
arrives. The first half is x402's `exact` scheme. The second half is Escro's `on-delivery` scheme, settled by the
Escro program on Solana in USDC. The two are complements, not rivals: an Escro vault only ever holds the funds of
async work, and an x402 payment never enters one.

## Picking a rail

**If the result comes back in the response you are paying for, pay `exact`; if the work finishes later and you
want to see it before the worker is paid, lock it `on-delivery`.**

| | Sync: `exact` | Async: `on-delivery` |
|---|---|---|
| When money moves | At the request, in the same exchange that returns the result | Locked at the request; released on delivery, refunded on a missed deadline |
| What the payer trusts | The server to answer once paid | The program to hold the funds and enforce the rules below |
| Where funds sit meanwhile | Nowhere: payer to payee directly | An escrow vault owned by a program address, never by Escro |
| Who decides it was worth it | Nobody; the request is the purchase | The buyer, after delivery |
| Escro's part | None in custody; the SDK's x402 rail pays an `exact` entry from the bot's own wallet (`pay()`) | The program holds the funds, the API builds the unsigned transactions, the oracle keeps time |

## The state machine

An `on-delivery` job is one escrow account. Every transition is an instruction the program validates; nothing
off-chain can move a job.

```text
create_escrow (buyer: amount + fee into the vault)
      |
   FUNDED --cancel_escrow (buyer)--------------------------> CANCELLED
      |    --refund_buyer (anyone, after deadline + 15 min)--> REFUNDED
   claim_task (assigned worker)
      |
 IN_PROGRESS --refund_buyer (anyone, after deadline + 15 min)--> REFUNDED
      |      --raise_dispute (buyer or worker)--> DISPUTED
   submit_deliverable (assigned worker; starts the 24 h review window)
      |
  SUBMITTED --release_payment (buyer)-------------------------> COMPLETED
            --timeout_release (oracle, 24 h after submission)--> COMPLETED
            --raise_dispute (buyer or worker)--> DISPUTED

 DISPUTED --arbitration_release (admin)--> COMPLETED
          --arbitration_refund (admin)---> REFUNDED
```

- **CANCELLED is a label, not an on-chain state.** `cancel_escrow` stores REFUNDED and emits `EscrowCancelled`; the
  API and the stats show CANCELLED from that event, and a raw account read shows REFUNDED.
- **The deadline guards delivery, not review.** A job not submitted by its deadline refunds the buyer once the
  15-minute grace has passed, and anyone may send that `refund_buyer`: it pays only the escrow's buyer. A submitted
  job is never refunded by the clock today.
- **A dispute has no timeout.** A DISPUTED escrow resolves only by an arbitration instruction signed by the admin
  authority, after a human decides off-chain. There is deliberately no automatic refund of a dispute: one would let a
  bad-faith buyer dispute, wait, and take the funds back.
- **The fee is the buyer's.** The buyer deposits the job amount plus the fee read from the platform config at
  creation; the worker receives the full amount. The minimum job is $5.00.

## The roles

| Role | Does | Never |
|---|---|---|
| Buyer | Funds the job, judges the delivery, releases or disputes | Is bypassed by the worker: it is paid only on the buyer's release, the 24 h timeout after submission, or arbitration |
| Worker (the assigned one) | Claims, delivers, may dispute | Releases its own payment |
| Program | Holds the USDC and enforces every transition and signer | Looks at the deliverable |
| Oracle | Keeps time: signs `timeout_release` once the on-chain clock allows it, and cranks expired refunds | Signs `release_payment`, `claim_task`, `submit_deliverable`, `cancel_escrow`, `update_platform` or an arbitration |
| Arbitrator | Decides a dispute off-chain; one admin signature executes it, to the buyer or the worker only | Acts on a job that is not disputed |

The buyer is the judge. It may run the check itself or hand the decision to an evaluator it names (a script, a
model, a person); the program knows only signatures, so an evaluator's verdict takes effect when the buyer signs
`release_payment` or `raise_dispute` (today's program has no on-chain evaluator field). Escro does not judge
quality, and nothing in the program or the oracle scores a deliverable.

## `settlementMode`: what silence means

After the worker submits, the buyer has the review window to act. `settlementMode` is the job term that says what
happens if the buyer says nothing before the window closes. On today's program a buyer that rejects the delivery
raises a dispute, which goes to arbitration.

| Value | Silence after submission | Status |
|---|---|---|
| `release` | The worker is paid: the oracle signs `timeout_release` 24 h after submission | **The default, and the only mode the program runs today** |
| `refund` | The buyer is refunded once the window and the 15-minute refund grace have passed | **Not available today.** It needs a change to the program's account layout |

`release` protects a worker from a buyer that goes quiet; `refund` would protect a buyer that cannot review in time.
A server on today's program advertises `settlementMode: "release"`, and a client that cannot accept that mode
refuses the offer rather than funding it. Before submission the mode changes nothing: a missed deadline always
refunds the buyer.
