/**
 * The declarations `defineConsumer` accepts, and the ones it refuses.
 *
 * Every refusal is marked with `@ts-expect-error`, which fails the compile when
 * the line beneath it stops being an error. The accepted declarations sit in
 * the same file and carry no directive, so the pair pins the boundary from both
 * sides: a change that loosened the check would leave a directive unused, and
 * one that tightened it too far would break an accepted declaration.
 *
 * `tsconfig.types.json` compiles this file with `noEmit`, and
 * `test/types.test.js` asserts that compile is clean.
 */
import { SpecificationOf, SpecificationRow } from "jinaga";
import { defineConsumer } from "../../src/consumer";

class Tenant {
    static Type = "Test.Tenant" as const;
    type = Tenant.Type;
    constructor(public identifier: string) {}
}

class Item {
    static Type = "Test.Item" as const;
    type = Item.Type;
    constructor(public tenant: Tenant, public key: string) {}
}

/** The completion fact, in the idiom the declaration requires. */
class ItemMirrored {
    static Type = "Test.Item.Mirrored" as const;
    type = ItemMirrored.Type;
    constructor(public item: Item) {}
}

/** Structurally identical to `ItemMirrored`, and a different declared type. */
class ItemArchived {
    static Type = "Test.Item.Archived" as const;
    type = ItemArchived.Type;
    constructor(public item: Item) {}
}

/** The `as const` is missing, so `type` widens to `string`. */
class ItemWidened {
    static Type = "Test.Item.Widened";
    type: string = ItemWidened.Type;
    constructor(public item: Item) {}
}

class ItemQuarantined {
    static Type = "Test.Item.Quarantined" as const;
    type = ItemQuarantined.Type;
    constructor(public item: Item, public reason: string) {}
}

const outstanding = null as unknown as SpecificationOf<[Tenant], Item>;
const acme = new Tenant("acme");
const complete = async (row: SpecificationRow<Item>) => new ItemMirrored(row.result);

// A well-formed declaration, with no quarantine group.
defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    handle: complete
});

// A well-formed declaration, with one.
defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    handle: complete,
    quarantine: {
        produces: ItemQuarantined,
        fact: async (row, event) => new ItemQuarantined(row.result, event.kind)
    }
});

// A fact class whose `type` widened to `string` is the declaration in which
// nothing could be checked, so `completes` refuses it.
defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [acme],
    // @ts-expect-error
    completes: ItemWidened,
    handle: async (row: SpecificationRow<Item>) => new ItemWidened(row.result)
});

// A handler returning a structurally identical fact of another declared type.
// The completion type is written out here rather than left to inference, which
// would take it from `handle` and report the disagreement against `completes`.
defineConsumer<[Tenant], Item, ItemMirrored>({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    // @ts-expect-error
    handle: async (row: SpecificationRow<Item>) => new ItemArchived(row.result)
});

// A handler that resolves without producing a completion fact.
defineConsumer<[Tenant], Item, ItemMirrored>({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    // @ts-expect-error
    handle: async () => {}
});

// A quarantine constructor with no factory.
defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    handle: complete,
    // @ts-expect-error
    quarantine: { produces: ItemQuarantined }
});

// A quarantine factory with no constructor.
defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    handle: complete,
    // @ts-expect-error
    quarantine: {
        fact: async (row: SpecificationRow<Item>) => new ItemQuarantined(row.result, "failed")
    }
});

// A quarantine factory returning a fact of a type the group does not declare.
defineConsumer<[Tenant], Item, ItemMirrored, ItemQuarantined>({
    name: "items",
    specification: outstanding,
    givens: [acme],
    completes: ItemMirrored,
    handle: complete,
    quarantine: {
        produces: ItemQuarantined,
        // @ts-expect-error
        fact: async (row: SpecificationRow<Item>) => new ItemArchived(row.result)
    }
});
