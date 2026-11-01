// Handlers for the human approval surface. Pure in the sense that they take a ledger runtime and a
// parsed body and return `{ status, body }`; the HTTP seam lives in `approvalHumanApi.ts`.
// The actor is fixed to 'human': `body.actor` is ignored, so a caller cannot write an audit row
// under someone else's name (QC M1).
//
// Barrel only: the handlers live in sibling modules split by concern so each stays inside the file
// budget. `approvalHumanShared.ts` (constants/coercers/replay store), `approvalHumanRead.ts`
// (challenge + list), `approvalHumanRequest.ts` (mint), `approvalHumanReview.ts` (decide/consume).
export {
  HUMAN_ACTOR,
  type Result,
} from './approvalHumanShared'
export { challengeRoute, listRoute } from './approvalHumanRead'
export { requestRoute } from './approvalHumanRequest'
export { consumeRoute, decideRoute } from './approvalHumanReview'
