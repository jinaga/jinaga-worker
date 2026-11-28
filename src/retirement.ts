import { Specification, exactInverses, pinLabel } from "jinaga";

/**
 * The fact types that can take a row out of an outstanding set.
 *
 * A type retires a row when a fact of it can make a condition on the row false:
 * the witness of a `notExists`, and the inner type of an `exists { notExists }`.
 *
 * The proved inverter answers that question directly. Each of its `removes` is
 * the specification the row stream runs when such a fact arrives, and the
 * arriving fact is the given labelled `pinLabel`, so that given's type is the
 * type that retires the row. The inverter pairs each of its inverses with every
 * top-level existential condition, so a type appears once per condition among
 * the removes; the returned set names it once.
 */
export function retiringTypes(specification: Specification): string[] {
    const pinned = exactInverses(specification).removes.flatMap(remove =>
        remove.given
            .filter(given => given.label.name === pinLabel)
            .map(given => given.label.type));
    return [...new Set(pinned)];
}

/**
 * Refuse a declaration whose fact type cannot take a row out of the outstanding
 * set.
 *
 * The two refusals are different diagnoses, so they carry different messages.
 * An empty `retiring` means the specification excludes nothing at all, and no
 * declaration could have matched it; a non-empty one that misses `declaredType`
 * means the declaration and the specification were written against each other,
 * and naming both sides is the whole of that diagnosis.
 *
 * Sound in one direction. An empty set proves the specification cannot shrink.
 * A non-empty one does not prove it will: a fact of a declared type built
 * against a predecessor the specification does not read is type-correct, retires
 * a different row, and still stalls. That residual is §10.2 T2, and the sweep is
 * what reports it.
 */
export function requireRetiringType(
    consumerName: string,
    option: string,
    declaredType: string,
    retiring: string[]
): void {
    if (retiring.length === 0) {
        throw new Error(
            `Consumer "${consumerName}" declares ${option} ${declaredType}, and its ` +
            `specification excludes no fact type at all. Nothing can retire a row, so ` +
            `every row would be dispatched until it exhausts its attempts. The ` +
            `specification needs a notExists over ${declaredType}.`
        );
    }
    if (!retiring.includes(declaredType)) {
        throw new Error(
            `Consumer "${consumerName}" declares ${option} ${declaredType}, which its ` +
            `specification does not exclude. It retires a row on: ${retiring.join(", ")}.`
        );
    }
}
