/**
 * The subject of the film: an order platform, big enough to be worth a picture.
 *
 * Written as `generate_graph` payloads, which means **no positions anywhere in this file**.
 * That is not a stylistic choice — a structural op cannot carry a coordinate, so the only
 * way an agent can put a 30-node graph on screen is to name the structure and let dagre
 * solve the geometry. The film is showing a real constraint, not a mock of one.
 *
 * Four diagrams, three levels deep: the platform, two of its services in detail, and one
 * component inside one of those. The lens trail in the film walks all three.
 */

export interface GeneratedNode {
  label: string;
  id?: string;
  color?: 'slate' | 'amber' | 'red' | 'green' | 'blue' | 'violet';
  data?: Record<string, unknown>;
}
export interface GeneratedEdge {
  source: string;
  target: string;
  label?: string;
  color?: GeneratedNode['color'];
}
export interface Diagram {
  name: string;
  nodes: GeneratedNode[];
  edges: GeneratedEdge[];
}

/** The top level: 31 nodes. What a request does to the platform, end to end. */
export const PLATFORM: Diagram = {
  name: 'order-platform',
  nodes: [
    { label: 'Client apps', id: 'client', color: 'blue' },
    { label: 'CDN / edge', id: 'edge' },
    { label: 'API gateway', id: 'gateway', color: 'blue' },
    { label: 'Rate limiter', id: 'ratelimit' },
    { label: 'Auth service', id: 'auth', color: 'violet' },
    { label: 'Session store (Redis)', id: 'sessions' },
    { label: 'Identity DB', id: 'identity-db' },

    { label: 'Order service', id: 'orders', color: 'green' },
    { label: 'Order DB', id: 'orders-db' },
    { label: 'Cart service', id: 'cart' },
    { label: 'Catalogue service', id: 'catalogue' },
    { label: 'Search index', id: 'search' },
    { label: 'Pricing engine', id: 'pricing' },

    { label: 'Payment service', id: 'payments', color: 'amber' },
    { label: 'Ledger', id: 'ledger' },
    { label: 'PSP adapter', id: 'psp' },
    { label: 'Stripe', id: 'stripe' },
    { label: 'Webhook receiver', id: 'webhooks' },

    { label: 'Inventory service', id: 'inventory' },
    { label: 'Reservation lock', id: 'reservation' },
    { label: 'Warehouse API', id: 'warehouse' },

    { label: 'Event bus (Kafka)', id: 'bus', color: 'violet' },
    { label: 'Fulfilment worker', id: 'fulfilment' },
    { label: 'Shipping service', id: 'shipping' },
    { label: 'Carrier API', id: 'carrier' },
    { label: 'Notification worker', id: 'notify' },
    { label: 'Email / SMS provider', id: 'provider' },
    { label: 'Analytics sink', id: 'analytics' },
    { label: 'Data warehouse', id: 'warehouse-db' },
    { label: 'Metrics + traces', id: 'telemetry' },
    { label: 'On-call alerting', id: 'alerting' },
  ],
  edges: [
    { source: 'client', target: 'edge' },
    { source: 'edge', target: 'gateway' },
    { source: 'gateway', target: 'ratelimit', label: 'check' },
    { source: 'gateway', target: 'auth', label: 'verify' },
    { source: 'auth', target: 'sessions' },
    { source: 'auth', target: 'identity-db' },

    { source: 'gateway', target: 'orders' },
    { source: 'gateway', target: 'cart' },
    { source: 'gateway', target: 'catalogue' },
    { source: 'catalogue', target: 'search' },
    { source: 'catalogue', target: 'pricing' },
    { source: 'cart', target: 'pricing' },
    { source: 'orders', target: 'orders-db' },
    { source: 'orders', target: 'cart', label: 'reads' },

    { source: 'orders', target: 'payments', label: 'authorise' },
    { source: 'payments', target: 'ledger', label: 'double entry' },
    { source: 'payments', target: 'psp' },
    { source: 'psp', target: 'stripe' },
    { source: 'stripe', target: 'webhooks', label: 'async result' },
    { source: 'webhooks', target: 'payments' },

    { source: 'orders', target: 'inventory', label: 'reserve' },
    { source: 'inventory', target: 'reservation' },
    { source: 'inventory', target: 'warehouse' },

    { source: 'orders', target: 'bus', label: 'order.placed' },
    { source: 'payments', target: 'bus', label: 'payment.settled' },
    { source: 'bus', target: 'fulfilment' },
    { source: 'bus', target: 'notify' },
    { source: 'bus', target: 'analytics' },
    { source: 'fulfilment', target: 'shipping' },
    { source: 'shipping', target: 'carrier' },
    { source: 'notify', target: 'provider' },
    { source: 'analytics', target: 'warehouse-db' },
    { source: 'telemetry', target: 'alerting' },
    { source: 'gateway', target: 'telemetry' },
    { source: 'payments', target: 'telemetry' },
  ],
};

/** Behind `Payment service`: 14 nodes, and where the real difficulty in payments lives. */
export const PAYMENTS: Diagram = {
  name: 'payment-service-detail',
  nodes: [
    { label: 'POST /payments', id: 'entry', color: 'blue' },
    { label: 'Idempotency key present?', id: 'idem-check', color: 'amber' },
    { label: 'Return the stored result', id: 'replay', color: 'green' },
    { label: 'Reject: 400 missing key', id: 'reject', color: 'red' },
    { label: 'Create payment intent', id: 'intent' },
    { label: 'Risk / fraud scoring', id: 'risk', color: 'violet' },
    { label: 'Score above threshold?', id: 'threshold', color: 'amber' },
    { label: 'Manual review queue', id: 'review' },
    { label: 'PSP adapter', id: 'adapter' },
    { label: 'Authorise with Stripe', id: 'authorise' },
    { label: 'Write ledger entries', id: 'ledger' },
    { label: 'Retry with backoff', id: 'retry' },
    { label: 'Dead letter queue', id: 'dlq', color: 'red' },
    { label: 'Emit payment.settled', id: 'emit', color: 'green' },
  ],
  edges: [
    { source: 'entry', target: 'idem-check' },
    { source: 'idem-check', target: 'replay', label: 'seen before' },
    { source: 'idem-check', target: 'reject', label: 'absent', color: 'red' },
    { source: 'idem-check', target: 'intent', label: 'new' },
    { source: 'intent', target: 'risk' },
    { source: 'risk', target: 'threshold' },
    { source: 'threshold', target: 'review', label: 'too high', color: 'amber' },
    { source: 'threshold', target: 'adapter', label: 'ok' },
    { source: 'adapter', target: 'authorise' },
    { source: 'authorise', target: 'ledger', label: 'on success' },
    { source: 'authorise', target: 'retry', label: 'on 5xx', color: 'amber' },
    { source: 'retry', target: 'adapter', label: 'attempt n+1' },
    { source: 'retry', target: 'dlq', label: 'gave up', color: 'red' },
    { source: 'ledger', target: 'emit' },
  ],
};

/** One level deeper again: inside the adapter. This is what the lens trail walks to. */
export const ADAPTER: Diagram = {
  name: 'psp-adapter-detail',
  nodes: [
    { label: 'Adapter call', id: 'call', color: 'blue' },
    { label: 'Pick provider by country', id: 'route' },
    { label: 'Stripe client', id: 'stripe' },
    { label: 'Adyen client', id: 'adyen' },
    { label: 'Map to provider schema', id: 'map' },
    { label: 'Sign + send', id: 'send' },
    { label: 'Circuit breaker open?', id: 'breaker', color: 'amber' },
    { label: 'Fail fast, no call', id: 'failfast', color: 'red' },
    { label: 'Normalise the response', id: 'normalise' },
    { label: 'Provider-specific error map', id: 'errors' },
    { label: 'Return a domain result', id: 'result', color: 'green' },
  ],
  edges: [
    { source: 'call', target: 'route' },
    { source: 'route', target: 'stripe', label: 'US / UK' },
    { source: 'route', target: 'adyen', label: 'EU' },
    { source: 'stripe', target: 'map' },
    { source: 'adyen', target: 'map' },
    { source: 'map', target: 'breaker' },
    { source: 'breaker', target: 'failfast', label: 'open', color: 'red' },
    { source: 'breaker', target: 'send', label: 'closed' },
    { source: 'send', target: 'normalise' },
    { source: 'normalise', target: 'errors' },
    { source: 'errors', target: 'result' },
  ],
};

/** Behind `Order service`: the state machine, including the paths people forget. */
export const ORDERS: Diagram = {
  name: 'order-service-detail',
  nodes: [
    { label: 'created', id: 'created', color: 'blue' },
    { label: 'stock reserved', id: 'reserved' },
    { label: 'payment authorised', id: 'authorised' },
    { label: 'paid', id: 'paid', color: 'green' },
    { label: 'fulfilling', id: 'fulfilling' },
    { label: 'shipped', id: 'shipped', color: 'green' },
    { label: 'closed', id: 'closed' },
    { label: 'reservation expired', id: 'expired', color: 'amber' },
    { label: 'payment failed', id: 'failed', color: 'red' },
    { label: 'release the reservation', id: 'release', color: 'amber' },
    { label: 'cancelled', id: 'cancelled', color: 'red' },
    { label: 'refund requested', id: 'refund' },
    { label: 'refunded', id: 'refunded', color: 'violet' },
  ],
  edges: [
    { source: 'created', target: 'reserved', label: 'reserve ok' },
    { source: 'created', target: 'cancelled', label: 'user cancels' },
    { source: 'reserved', target: 'authorised', label: 'authorise ok' },
    { source: 'reserved', target: 'expired', label: 'ttl', color: 'amber' },
    { source: 'expired', target: 'release' },
    { source: 'release', target: 'cancelled' },
    { source: 'authorised', target: 'paid', label: 'captured' },
    { source: 'authorised', target: 'failed', label: '5xx / declined', color: 'red' },
    { source: 'failed', target: 'release' },
    { source: 'paid', target: 'fulfilling' },
    { source: 'fulfilling', target: 'shipped' },
    { source: 'shipped', target: 'closed' },
    { source: 'shipped', target: 'refund', label: 'return window' },
    { source: 'refund', target: 'refunded' },
    { source: 'refunded', target: 'closed' },
  ],
};

/** Which top-level node each detail diagram hangs off, and the trail the film walks. */
export const LINKS: Array<{ diagram: string; node: string; subcanvas: string }> = [
  { diagram: PLATFORM.name, node: 'payments', subcanvas: PAYMENTS.name },
  { diagram: PLATFORM.name, node: 'orders', subcanvas: ORDERS.name },
  { diagram: PAYMENTS.name, node: 'adapter', subcanvas: ADAPTER.name },
];

export const ALL = [PLATFORM, PAYMENTS, ADAPTER, ORDERS];
