import { hashPortalPassword } from "../web/portalAuth.js";

// Never accept plaintext through argv, environment, or echoed readline input.
if (
  process.argv.length !== 2 ||
  !process.stdin.isTTY ||
  !process.stdout.isTTY
) {
  console.error(
    "Run interactively without arguments: node scripts/hashPortalPassword.js",
  );
  process.exitCode = 1;
} else {
  const input = process.stdin;
  let password = "";
  let first;
  process.stdout.write("Password (12+ characters): ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  const finish = () => {
    input.setRawMode(false);
    input.pause();
    input.removeAllListeners("data");
  };
  input.on("data", (data) => {
    for (const char of data) {
      if (char === "\u0003" || char === "\u0004") {
        finish();
        process.stdout.write("\nCancelled\n");
        return;
      }
      if (char === "\r" || char === "\n") {
        if (first === undefined) {
          first = password;
          password = "";
          process.stdout.write("\nConfirm password: ");
        } else {
          finish();
          process.stdout.write("\n");
          if (password !== first) {
            console.error("Passwords do not match");
            process.exitCode = 1;
            return;
          }
          try {
            console.log(hashPortalPassword(password));
          } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
          }
          password = "";
          first = "";
          return;
        }
      } else if (char === "\u007f" || char === "\b")
        password = Array.from(password).slice(0, -1).join("");
      else if (char >= " " && Buffer.byteLength(password) < 1024)
        password += char;
    }
  });
}
