# DRY — Code Examples (Java)

### Violation — same business rule in two places

```java
// In controller
public class LeaveController {
    public Response createLeaveRequest(CreateRequest dto) {
        Employee emp = employeeRepo.findById(dto.getEmployeeId());
        if (emp.getProbationEndDate().isAfter(now())
            || !"Active".equals(emp.getEmploymentStatus())) {
            return Response.badRequest("not eligible");
        }
        // ... create
    }
}

// In batch job
public class LeaveAutoApproval {
    public void processPending() {
        for (LeaveRequest req : leaveRepo.getPending()) {
            Employee emp = employeeRepo.findById(req.getEmployeeId());
            if (emp.getProbationEndDate().isAfter(now())
                || !"Active".equals(emp.getEmploymentStatus())) {
                req.reject("not eligible");
                continue;
            }
            req.approve();
        }
    }
}
```

### Following DRY — single source of truth

```java
public class Employee {
    private final LocalDate probationEndDate;
    private final String employmentStatus;

    public boolean isEligibleForLeave() {
        return probationEndDate.isBefore(LocalDate.now())
            && "Active".equals(employmentStatus);
    }
}
```

Both call sites now use `employee.isEligibleForLeave()`. The business rule lives in one place.
When the rule changes, one file changes.

### Structural duplication — abstract at 2

```java
// Two functions, same algorithm, different types → abstract now
public List<String> parseStrings(List<String> raw, Rule<String> rule) {
    return raw.stream().filter(rule::matches).collect(toList());
}
public List<Integer> parseIntegers(List<Integer> raw, Rule<Integer> rule) {
    return raw.stream().filter(rule::matches).collect(toList());
}

// After: generic
public <T> List<T> parse(List<T> raw, Rule<T> rule) {
    return raw.stream().filter(rule::matches).collect(toList());
}
```

This is not a "maybe" abstraction. The algorithm is identical. The only difference is the type.
The generic is the natural, simpler expression of the code — and it's easier to test.

### Accidental duplication — do NOT merge

```java
// Looks like duplication — is not. Different fields, different rules that evolve separately.
public boolean isValidEmail(String email) {
    return email != null && email.contains("@");
}
public boolean isValidPhone(String phone) {
    return phone != null && phone.matches("\\d{10}");
}
```

Same shape (null-check + predicate), different knowledge. Merging them into one
`isValidField(value, predicate)` adds indirection for a coincidence, not a duplication.
