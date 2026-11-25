// Compatibility entry point; all callers share the feature's live sessions.
export {
  startTrade,
  startGift,
  cancelTransfer,
  onTradeAnswer,
  prepareTransferCancellation,
} from "../features/trade/tradeRuntime.js";
