# Falsifiability examples: TypeScript / JavaScript

The question behind every test: **"if this code were broken, would this test catch it?"**
If the answer is no, the test verifies nothing. Each example pairs a test that passes on
broken code with the fix that makes it falsifiable.

### 1. Test with no expectation (passes no matter what)

```typescript
// Code under test
export function discount(price: number, percent: number): number {
  return price * (1 - percent / 100);
}

// Won't catch a bug: runs the function, expects nothing
test("discount runs", () => {
  discount(100, 10); // passes even if the formula is broken
});

// Falsifiable: fixes the expected result
test("discount applies the percentage", () => {
  expect(discount(100, 10)).toBe(90);
});
```

### 2. Test that duplicates the implementation logic

```typescript
// Code under test
export function firstWord(text: string): string {
  return text.split(" ")[0] ?? "";
}

// Won't catch a bug: replicates the split, so it breaks together with the code
test("firstWord splits on spaces", () => {
  const text = "hola mundo";
  expect(firstWord(text)).toBe(text.split(" ")[0]); // same expression on both sides
});

// Falsifiable: fixes the expected behavior
test("firstWord returns the first word", () => {
  expect(firstWord("hola mundo")).toBe("hola");
  expect(firstWord("solo")).toBe("solo");
});
```
