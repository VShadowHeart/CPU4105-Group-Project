const form = document.getElementById("registrationForm");
const result = document.getElementById("result");

// Mark a field as valid or invalid by adding a CSS class to its group
function setState(groupId, isValid) {
  const group = document.getElementById(groupId);
  group.classList.remove("error", "success");
  group.classList.add(isValid ? "success" : "error");
  return isValid;
}

function isAtLeast16(dobText) {
  if (!dobText) return false;
  const dob = new Date(dobText);
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 16);
  return dob <= cutoff;
}

form.addEventListener("submit", async function (event) {
  event.preventDefault();               // stop the page reloading

  const fullName = document.getElementById("fullName").value.trim();
  const email = document.getElementById("email").value.trim();
  const dob = document.getElementById("dob").value;
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  const nameOk = setState("groupFullName", fullName.length >= 2);
  const emailOk = setState("groupEmail", emailPattern.test(email));
  const dobOk = setState("groupDob", isAtLeast16(dob));

  if (!(nameOk && emailOk && dobOk)) {
    result.textContent = "Please fix the highlighted fields.";
    return;
  }

  // ---- Part 4: send the data to the API as JSON ----
  const payload = { fullName: fullName, email: email, dob: dob };
  try {
    const response = await fetch("/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (response.ok) {
      result.textContent = data.message + " (customer id " + data.id + ")";
      form.reset();
    } else {
      result.textContent = "Server said " + response.status + ": " +
        JSON.stringify(data.detail);
    }
  } catch (err) {
    result.textContent = "Could not reach the server. Is uvicorn running?";
  }
});
