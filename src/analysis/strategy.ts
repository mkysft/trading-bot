import { Order, Contract } from "ib-tws-api";
import { RiskConfig } from "@config";
import { AccountCapitalSnapshot, PositionSnapshot, TradeOrder } from "@ibkr/client";
import { MarketSignal } from "./volatilityScanner";

export interface OptionLeg {
  action: "BUY" | "SELL";
  type: "CALL" | "PUT";
  strike: number;
  expiry: string;
  quantity: number;
}

export interface StrategyProposal {
  symbol: string;
  rationale: string[];
  expectedVolatilityEdge: number;
  estimatedCost: number;
  orders: TradeOrder[];
}

const SHORT_DATED_EXPIRIES = 7; // days

const buildOptionContract = (
  symbol: string,
  leg: OptionLeg,
  exchange = "SMART",
): Contract => ({
  symbol,
  secType: "OPT",
  exchange,
  currency: "USD",
  lastTradeDateOrContractMonth: leg.expiry.replace(/-/g, ""),
  strike: leg.strike,
  right: leg.type,
  multiplier: "100",
});

const buildOrder = (leg: OptionLeg, limitPrice: number): Order => ({
  action: leg.action,
  orderType: "LMT",
  totalQuantity: leg.quantity,
  lmtPrice: Number(limitPrice.toFixed(2)),
  tif: "DAY",
});

export class StrategyEngine {
  constructor(private readonly risk: RiskConfig) {}

  generateProposals(
    signals: MarketSignal[],
    account: AccountCapitalSnapshot,
    positions: PositionSnapshot[],
  ): StrategyProposal[] {
    const availableSlots = Math.max(this.risk.maxOpenPositions - positions.length, 0);
    if (!availableSlots) return [];

    const sortedSignals = [...signals].sort((a, b) => {
      const edgeA = a.impliedVolatility - a.historicalVolatility;
      const edgeB = b.impliedVolatility - b.historicalVolatility;
      return edgeB - edgeA;
    });

    const perTradeCapital = Math.min(
      this.risk.maxCapitalPerTrade,
      account.availableFunds / Math.max(availableSlots, 1),
    );

    const proposals: StrategyProposal[] = [];

    for (const signal of sortedSignals) {
      if (signal.impliedVolatility <= signal.historicalVolatility * 1.15) {
        continue;
      }

      const edge = signal.impliedVolatility - signal.historicalVolatility;
      const expiry = this.calculateExpiry(SHORT_DATED_EXPIRIES);
      const strike = Number((signal.lastPrice * 1.05).toFixed(2));
      const theoreticalPremium = signal.lastPrice * 0.05 || 1;
      const limitPrice = Number(theoreticalPremium.toFixed(2));
      const contracts = Math.max(Math.floor(perTradeCapital / Math.max(limitPrice * 100, 1)), 1);

      const longCall: OptionLeg = {
        action: "BUY",
        type: "CALL",
        strike,
        expiry,
        quantity: contracts,
      };

      const contract = buildOptionContract(signal.symbol, longCall);
      const order = buildOrder(longCall, limitPrice);

      proposals.push({
        symbol: signal.symbol,
        rationale: [
          `Implied volatility (${signal.impliedVolatility.toFixed(2)}) materially exceeds historical (${signal.historicalVolatility.toFixed(2)}).`,
          `Sentiment score ${signal.sentimentScore.toFixed(2)} with catalysts: ${signal.catalysts.join(", ")}.`,
        ],
        expectedVolatilityEdge: edge,
        estimatedCost: limitPrice * contracts * 100,
        orders: [
          {
            contract,
            order,
          },
        ],
      });

      if (proposals.length >= availableSlots) {
        break;
      }
    }

    return proposals;
  }

  private calculateExpiry(daysOut: number): string {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + daysOut);
    return `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`;
  }
}
