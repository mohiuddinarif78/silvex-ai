import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay calls this address on its own after every payment, so deposits are
 * credited without anyone pressing anything.
 */
export const Route = createFileRoute("/api/public/razorpay/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature") || "";
        const { verifyWebhook } = await import("@/lib/razorpay.server");
        if (!(await verifyWebhook(raw, signature))) {
          return new Response("Invalid signature", { status: 401 });
        }

        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          return new Response("Bad payload", { status: 400 });
        }

        const event = String(body?.event || "");
        const paid =
          event === "payment_link.paid" ||
          event === "payment.captured" ||
          event === "order.paid";
        if (!paid) return new Response("ignored");

        const payment = body?.payload?.payment?.entity ?? {};
        const link = body?.payload?.payment_link?.entity ?? {};

        // The webhook body is only a trigger. We take the payment id from it and
        // then VERIFY that payment directly against Razorpay with the secret
        // key — the posted amount/status/notes are never trusted to credit.
        const paymentId = String(payment.id || "");
        if (!paymentId) return new Response("ignored");

        const { verifyRazorpayPayment, creditDeposit } = await import("@/lib/razorpay.server");
        const verified = await verifyRazorpayPayment(paymentId);
        if (!verified.ok) {
          // Fake/test/uncaptured/wrong-currency payment: credit nothing.
          return new Response("ignored");
        }

        const uid = String(verified.notes["uid"] || "").trim();
        if (!uid) return new Response("ignored");

        // Credit strictly from the rupees Razorpay confirms were captured.
        // creditDeposit re-derives USD server-side and reconciles against the
        // originating link, so amount/rate manipulation is impossible here.
        await creditDeposit({
          uid,
          inr: verified.inrCaptured,
          paymentId: verified.paymentId,
          // payment.captured events may omit payload.payment_link but the
          // payment itself carries the originating link id.
          linkId: verified.linkId || String(link.id || payment.payment_link_id || ""),
          email: verified.notes["email"] || "",
          productId: String(verified.notes["pid"] || ""),
          qty: Number(verified.notes["qty"] || 1),
          chatId: Number(verified.notes["chat"] || 0),
        });

        return new Response("ok");
      },
      GET: async () => new Response("Razorpay webhook is live"),
    },
  },
});
