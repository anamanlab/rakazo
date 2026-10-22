import { z } from "zod";

/**
 * The app runs under a policy without `'unsafe-eval'`, so zod's validator JIT cannot compile.
 * Its feature probe calls `Function("")`; the throw is caught, but a strict CSP still reports a
 * violation, which lands in the API's violation log on every fresh page. Configure it before any
 * schema validates so the probe is not attempted.
 */
z.config({ jitless: true });
