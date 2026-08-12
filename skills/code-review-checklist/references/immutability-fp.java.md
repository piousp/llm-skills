# Immutability & FP examples: Java

Is this state necessary, and does the error live where the caller can see it? This file
covers: **mutable variable where `final` works**, **function that modifies its input
arguments**, and **exception thrown for a domain error that should be in the return
type**. Each example pairs a change the review should flag with the fix that satisfies
the checklist.

### 1. Mutable variable where final works

```java
// Anti-pattern: the local is never reassigned, so the mutability is pure cost: readers
// must check every line for a hidden reassignment
int total(List<Item> items) {
    int sum = 0;
    for (Item i : items) sum += i.price();
    return sum;
}

// Fix: final makes the binding permanent, and the compiler now rejects accidental
// reassignment
int total(List<Item> items) {
    return items.stream().mapToInt(Item::price).sum();
}
```

### 2. Function modifies its input arguments

```java
// Anti-pattern: Collections.sort mutates the caller's list, so the caller loses its
// data order and the method has a hidden side effect
List<Integer> topN(List<Integer> xs, int n) {
    Collections.sort(xs); // mutates the caller's list
    return xs.subList(0, n);
}

// Fix: return a new value, so the caller keeps its list intact and the method stays pure
List<Integer> topN(List<Integer> xs, int n) {
    return xs.stream().sorted().limit(n).toList();
}
```

### 3. Exception for a domain error that belongs in the return type

```java
// Anti-pattern: a lookup failure throws, so the caller must remember to catch and the
// compiler cannot prove the error path is handled
User findUser(long id) {
    return users.stream().filter(u -> u.id() == id).findFirst()
        .orElseThrow(() -> new UserNotFound(id));
}

// Fix: the error lives in the return type, so the caller must handle both cases and
// the compiler enforces it
Optional<User> findUser(long id) {
    return users.stream().filter(u -> u.id() == id).findFirst();
}
```
