# Immutability & FP examples: Scala

Is this state necessary, and does the error live where the caller can see it? This file
covers: **mutable variable where `val` works**, **function that modifies its input
arguments**, and **exception thrown for a domain error that should be in the return
type**. Each example pairs a change the review should flag with the fix that satisfies
the checklist.

### 1. Mutable variable where val works

```scala
// Anti-pattern: the var is never reassigned, so the mutability is pure cost: readers
// must check every line for a hidden reassignment
def total(items: Seq[Item]): Int = {
  var sum = 0
  items.foreach(i => sum += i.price)
  sum
}

// Fix: val makes the binding final, and the compiler now rejects accidental reassignment
def total(items: Seq[Item]): Int =
  items.map(_.price).sum
```

### 2. Function modifies its input arguments

```scala
// Anti-pattern: sortInPlace mutates the caller's buffer, so the caller loses its data
// order and the function has a hidden side effect
def topN(xs: ArrayBuffer[Int], n: Int): ArrayBuffer[Int] = {
  xs.sortInPlace() // mutates the caller's buffer
  xs.take(n)
}

// Fix: return a new value, so the caller keeps its buffer intact and the function stays pure
def topN(xs: Seq[Int], n: Int): Seq[Int] =
  xs.sorted.take(n)
```

### 3. Exception for a domain error that belongs in the return type

```scala
// Anti-pattern: a lookup failure throws, so the caller must remember to catch and the
// compiler cannot prove the error path is handled
def findUser(id: Long): User =
  users.find(_.id == id).getOrElse(throw new UserNotFound(id))

// Fix: the error lives in the return type, so the caller must handle both cases and
// the compiler enforces it
def findUser(id: Long): Option[User] =
  users.find(_.id == id)
```
