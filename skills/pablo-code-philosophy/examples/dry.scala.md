# DRY — Code Examples (Scala)

### Violation — same business rule in two places

```scala
// In controller
class LeaveController {
  def createLeaveRequest(dto: CreateRequest): Response = {
    val emp = employeeRepo.findById(dto.employeeId)
    if (emp.probationEndDate.isAfter(now) || emp.employmentStatus != "Active")
      Response.badRequest("not eligible")
    else { /* ... create */ }
  }
}

// In batch job
class LeaveAutoApproval {
  def processPending(): Unit =
    leaveRepo.getPending.foreach { req =>
      val emp = employeeRepo.findById(req.employeeId)
      if (emp.probationEndDate.isAfter(now) || emp.employmentStatus != "Active")
        req.reject("not eligible")
      else req.approve()
    }
}
```

### Following DRY — single source of truth

```scala
case class Employee(probationEndDate: LocalDate, employmentStatus: String) {
  def isEligibleForLeave: Boolean =
    probationEndDate.isBefore(LocalDate.now()) && employmentStatus == "Active"
}
```

Both call sites now use `employee.isEligibleForLeave`. The business rule lives in one place.

### Structural duplication — abstract at 2

```scala
// Two functions, same algorithm, different types → abstract now
def parseStrings(raw: List[String], rule: Rule[String]): List[String] =
  raw.filter(rule.matches)
def parseIntegers(raw: List[Int], rule: Rule[Int]): List[Int] =
  raw.filter(rule.matches)

// After: generic
def parse[T](raw: List[T], rule: Rule[T]): List[T] =
  raw.filter(rule.matches)
```

This is not a "maybe" abstraction. The algorithm is identical. The only difference is the type.

### Accidental duplication — do NOT merge

```scala
// Looks like duplication — is not. Different fields, different rules that evolve separately.
def isValidEmail(email: String): Boolean = email != null && email.contains("@")
def isValidPhone(phone: String): Boolean = phone != null && phone.matches("\\d{10}")
```

Same shape (null-check + predicate), different knowledge. Merging them adds indirection for a
coincidence, not a duplication.
