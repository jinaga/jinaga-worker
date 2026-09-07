import { invertSpecification, Specification } from "jinaga";

/**
 * The fact types that can take a row out of an outstanding set.
 *
 * A specification shrinks only where inverting it yields a `remove`, and a
 * remove inverse is produced exactly by a condition whose `exists` is false.
 * The types that retire a row are therefore the givens of those inverses:
 * assert a fact of one of them against the predecessor the condition reads, and
 * the row leaves the set.
 *
 * A positive `exists` therefore yields nothing: it gates which rows enter the
 * set rather than completing one, so it inverts to an add. Depth does not
 * matter either — a condition on a nested unknown, or on an outer hop, yields
 * its type the same way as one at the top level.
 *
 * Inversion is memoized on the specification's structure, so this call warms
 * the entry `subscribeRows` then hits.
 */
export function retiringTypes(specification: Specification): string[] {
    return invertSpecification(specification)
        .filter(inverse => inverse.operation === "remove")
        .flatMap(inverse => inverse.inverseSpecification.given.map(given => given.label.type));
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
 * A non-empty one does not prove it will: a fact of the declared type built
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
