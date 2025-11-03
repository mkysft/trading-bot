import { EventEmitter } from "events";
import { IBApi, Order, Contract } from "ib-tws-api";
import { IBKRCredentials } from "@config";

export interface AccountCapitalSnapshot {
  availableFunds: number;
  buyingPower: number;
  currency: string;
  timestamp: Date;
}

export interface PositionSnapshot {
  symbol: string;
  quantity: number;
  averageCost: number;
  account: string;
}

export interface TradeOrder {
  contract: Contract;
  order: Order;
}

export class IBKRClient {
  private api: IBApi;
  private connected = false;
  private connectionPromise?: Promise<void>;
  private orderEmitter = new EventEmitter();
  private currentOrderId?: number;

  constructor(private readonly credentials: IBKRCredentials) {
    this.api = new IBApi({
      host: credentials.host,
      port: credentials.port,
      clientId: credentials.clientId,
    });

    this.api.on("connected", () => {
      this.connected = true;
    });

    this.api.on("disconnected", () => {
      this.connected = false;
    });

    this.api.on("nextValidId", (orderId: number) => {
      this.currentOrderId = orderId;
      this.orderEmitter.emit("nextValidId", orderId);
    });
  }

  private async ensureConnection(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!this.connectionPromise) {
      this.connectionPromise = new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          this.api.off("error", onError);
          reject(err);
        };

        this.api.once("nextValidId", () => {
          this.api.off("error", onError);
          resolve();
        });

        this.api.on("error", onError);
        this.api.connect();
      });
    }

    await this.connectionPromise;
    this.connected = true;
  }

  async authenticate(): Promise<void> {
    await this.ensureConnection();
  }

  async getAccountCapital(): Promise<AccountCapitalSnapshot> {
    await this.ensureConnection();

    return await new Promise<AccountCapitalSnapshot>((resolve, reject) => {
      const requestId = Date.now();
      const totals: Partial<AccountCapitalSnapshot> = {
        availableFunds: 0,
        buyingPower: 0,
        currency: "USD",
        timestamp: new Date(),
      };

      const onSummary = (
        id: number,
        _account: string,
        tag: string,
        value: string,
        currency: string,
      ) => {
        if (id !== requestId) return;

        if (tag === "AvailableFunds") {
          totals.availableFunds = Number(value);
        }

        if (tag === "BuyingPower") {
          totals.buyingPower = Number(value);
        }

        totals.currency = currency;
      };

      const onSummaryEnd = (id: number) => {
        if (id !== requestId) return;
        cleanup();
        resolve({
          availableFunds: totals.availableFunds ?? 0,
          buyingPower: totals.buyingPower ?? 0,
          currency: totals.currency ?? "USD",
          timestamp: new Date(),
        });
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.api.off("accountSummary", onSummary as any);
        this.api.off("accountSummaryEnd", onSummaryEnd as any);
        this.api.off("error", onError as any);
      };

      this.api.on("accountSummary", onSummary as any);
      this.api.on("accountSummaryEnd", onSummaryEnd as any);
      this.api.on("error", onError as any);

      this.api.reqAccountSummary(
        requestId,
        this.credentials.paperTrading ? "DU" : "All",
        "AvailableFunds,BuyingPower",
      );
    });
  }

  async getOpenPositions(): Promise<PositionSnapshot[]> {
    await this.ensureConnection();

    return await new Promise<PositionSnapshot[]>((resolve, reject) => {
      const positions: PositionSnapshot[] = [];

      const onPosition = (
        account: string,
        contract: Contract,
        position: number,
        avgCost: number,
      ) => {
        positions.push({
          account,
          symbol: contract.symbol ?? contract.localSymbol ?? "UNKNOWN",
          quantity: position,
          averageCost: avgCost,
        });
      };

      const onPositionEnd = () => {
        cleanup();
        resolve(positions);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.api.off("position", onPosition as any);
        this.api.off("positionEnd", onPositionEnd as any);
        this.api.off("error", onError as any);
      };

      this.api.on("position", onPosition as any);
      this.api.on("positionEnd", onPositionEnd as any);
      this.api.on("error", onError as any);
      this.api.reqPositions();
    });
  }

  async placeOrder(orderDetails: TradeOrder): Promise<number> {
    await this.ensureConnection();

    const orderId = await this.nextOrderId();

    return await new Promise<number>((resolve, reject) => {
      const onStatus = (
        id: number,
        status: string,
        _filled: number,
        _remaining: number,
      ) => {
        if (id !== orderId) return;

        if (["Submitted", "Filled", "PreSubmitted"].includes(status)) {
          cleanup();
          resolve(orderId);
        }

        if (status === "Rejected") {
          cleanup();
          reject(new Error(`Order ${orderId} rejected by IBKR`));
        }
      };

      const onError = (id: number, errorCode: number, message: string) => {
        if (id !== orderId) return;
        cleanup();
        reject(new Error(`Order error ${errorCode}: ${message}`));
      };

      const cleanup = () => {
        this.api.off("orderStatus", onStatus as any);
        this.api.off("error", onError as any);
      };

      this.api.on("orderStatus", onStatus as any);
      this.api.on("error", onError as any);

      this.api.placeOrder(orderId, orderDetails.contract, orderDetails.order);
    });
  }

  private async nextOrderId(): Promise<number> {
    if (typeof this.currentOrderId === "number") {
      return this.currentOrderId++;
    }

    await this.ensureConnection();

    return await new Promise<number>((resolve) => {
      this.orderEmitter.once("nextValidId", (orderId: number) => {
        this.currentOrderId = orderId + 1;
        resolve(orderId);
      });
    });
  }

  disconnect() {
    if (this.connected) {
      this.api.disconnect();
      this.connected = false;
    }
  }
}
