import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Download,
  Gift,
  KeyRound,
  LogOut,
  Lightbulb,
  Mail,
  PackageCheck,
  Receipt,
  ShieldCheck,
  Smartphone,
  Users,
  Wallet,
} from "lucide-react";
import { equalTo, get, orderByChild, query, ref, update } from "@/lib/fb/database";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  signOut,
  updatePassword,
  verifyBeforeUpdateEmail,
} from "@/lib/fb/auth";
import { useStore } from "@/context/StoreContext";
import {
  botReferralLink,
  referralCap,
  referralPercent,
  referralEarnings,
  websiteReferralLink,
} from "@/lib/referral";
import { isAppInstalled, startAppInstall } from "@/lib/pwa-install";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "My Profile — Silvex AI" },
      { name: "description", content: "Manage your wallet, phone number, referral code and orders." },
      { property: "og:title", content: "My Profile — Silvex AI" },
      { property: "og:description", content: "Manage your wallet, phone number, referral code and orders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const { auth, db, user, profile, wallet, isAdmin, openModal, showSuccess, notify } = useStore();
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [passBusy, setPassBusy] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [mailPass, setMailPass] = useState("");
  const [mailBusy, setMailBusy] = useState(false);
  const isEmailUser = user?.providerData?.some((p) => p.providerId === "password") ?? false;
  const navigate = useNavigate();
  const [invited, setInvited] = useState(0);
  const earnings = useMemo(
    () => referralEarnings(Object.values(profile?.history ?? {})),
    [profile?.history],
  );

  useEffect(() => setPhone(profile?.phone ?? ""), [profile?.phone]);

  useEffect(() => {
    const code = profile?.myRefCode;
    if (!db || !code) return;
    get(query(ref(db, "users"), orderByChild("usedRef"), equalTo(code)))
      .then((s) => setInvited(s.exists() ? Object.keys(s.val()).length : 0))
      .catch(() => setInvited(0));
  }, [db, profile?.myRefCode]);

  if (!user) {
    return (
      <div className="fade-in">
        <EmptyState
          icon={ShieldCheck}
          title="Log in to see your profile"
          description="Manage your wallet, referral code, security and orders."
          action={<Button onClick={() => openModal("auth")}>Login</Button>}
        />
      </div>
    );
  }

  async function changePassword() {
    if (!auth || !user || !user.email) return;
    if (newPass.length < 6) return notify("New password must be at least 6 characters");
    setPassBusy(true);
    try {
      const cred = EmailAuthProvider.credential(user.email, curPass);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPass);
      setCurPass("");
      setNewPass("");
      showSuccess("Password changed", "Use your new password next time you log in.");
    } catch (e) {
      const code = (e as { code?: string })?.code || "";
      notify(
        code === "auth/wrong-password" || code === "auth/invalid-credential"
          ? "Your current password is wrong."
          : code === "auth/too-many-requests"
            ? "Too many attempts. Please wait a minute and try again."
            : "Could not change password. Please try again.",
      );
    } finally {
      setPassBusy(false);
    }
  }

  async function changeEmail() {
    if (!auth || !user || !user.email) return;
    const mail = newEmail.trim().toLowerCase();
    if (!mail || !mail.includes("@")) return notify("Enter a valid new email address");
    setMailBusy(true);
    try {
      const cred = EmailAuthProvider.credential(user.email, mailPass);
      await reauthenticateWithCredential(user, cred);
      await verifyBeforeUpdateEmail(user, mail);
      setNewEmail("");
      setMailPass("");
      showSuccess(
        "Check your new inbox",
        `We sent a confirmation link to ${mail}. Your email changes after you tap it.`,
      );
    } catch (e) {
      const code = (e as { code?: string })?.code || "";
      notify(
        code === "auth/wrong-password" || code === "auth/invalid-credential"
          ? "Your current password is wrong."
          : code === "auth/email-already-in-use"
            ? "That email already belongs to another account."
            : code === "auth/too-many-requests"
              ? "Too many attempts. Please wait a minute and try again."
              : "Could not change email. Please try again.",
      );
    } finally {
      setMailBusy(false);
    }
  }

  async function savePhone() {
    if (!db || !user) return;
    if (phone.length < 10) return notify("Enter a valid phone number");
    await update(ref(db, `users/${user.uid}`), { phone });
    showSuccess("Updated", "Phone number saved.");
  }

  async function installApp() {
    const result = await startAppInstall();
    if (result === "installed") notify("App is already installed");
    else if (result === "prompted") notify("Installing app…");
    else
      notify(
        isAppInstalled()
          ? "App is already installed"
          : "Open your browser menu and tap 'Add to Home screen' to install the app",
      );
  }

  async function logout() {
    if (auth) await signOut(auth);
    notify("Logged out");
    navigate({ to: "/" });
  }

  const quickLinks = [
    { icon: PackageCheck, label: "Orders", onClick: () => navigate({ to: "/orders" }) },
    { icon: Wallet, label: "Wallet & deposits", onClick: () => openModal("wallet") },
    { icon: Lightbulb, label: "Request a product", onClick: () => openModal("suggestion") },
  ];

  return (
    <div className="fade-in mx-auto max-w-3xl space-y-5">
      <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">My profile</h1>

      {/* Account + wallet */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="flex items-center gap-4">
            <Avatar className="size-14 text-lg ring-1 ring-border">
              {user.photoURL ? <AvatarImage src={user.photoURL} alt="" /> : null}
              <AvatarFallback>{(profile?.name || user.email || "U").slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg font-semibold">
                {profile?.name || user.displayName || "User"}
              </h2>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              {isAdmin ? (
                <Badge variant="muted" className="mt-1.5">
                  <ShieldCheck className="size-3" /> Admin
                </Badge>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="justify-center bg-primary text-primary-foreground">
          <CardContent className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide opacity-80">Wallet balance</p>
              <p className="font-display text-3xl font-bold tabular-nums">${wallet}</p>
            </div>
            <Button
              variant="secondary"
              className="bg-white/15 text-white hover:bg-white/25"
              onClick={() => openModal("wallet")}
            >
              <Wallet className="size-4" /> Top up
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <div className="grid gap-2 sm:grid-cols-3">
        {quickLinks.map((l) => {
          const Icon = l.icon;
          return (
            <button
              key={l.label}
              onClick={l.onClick}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 text-left text-sm font-medium shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4" />
              </span>
              {l.label}
            </button>
          );
        })}
        <Button variant="outline" className="justify-start gap-3 h-auto p-3.5" asChild>
          <Link to="/history">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Receipt className="size-4" />
            </span>
            Wallet history
          </Link>
        </Button>
        <Button variant="outline" className="justify-start gap-3 h-auto p-3.5" asChild>
          <Link to="/api-key">
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <KeyRound className="size-4" />
            </span>
            Reseller API key
          </Link>
        </Button>
        {isAdmin ? (
          <Button variant="outline" className="justify-start gap-3 h-auto p-3.5" asChild>
            <Link to="/admin" search={{ view: "analysis" }}>
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldCheck className="size-4" />
              </span>
              Admin panel
            </Link>
          </Button>
        ) : null}
      </div>

      {/* Referral */}
      {profile?.myRefCode ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="size-4 text-primary" /> Refer &amp; earn
            </CardTitle>
            <CardDescription>
              Earn {referralPercent()}% commission on every purchase your friend makes (up to $
              {referralCap()} per friend).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Your code</span>
              <Badge className="font-display tracking-wide">{profile.myRefCode}</Badge>
            </div>

            <div className="space-y-2">
              <ReferralLink
                label="Website link"
                value={websiteReferralLink(profile.myRefCode)}
                onCopy={() => {
                  navigator.clipboard?.writeText(websiteReferralLink(profile.myRefCode!));
                  notify("Referral link copied");
                }}
              />
              <ReferralLink
                label="Telegram bot link"
                value={botReferralLink(profile.myRefCode)}
                onCopy={() => {
                  navigator.clipboard?.writeText(botReferralLink(profile.myRefCode!));
                  notify("Bot link copied");
                }}
              />
            </div>

            <Separator />

            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4 text-muted-foreground" /> {invited} total referrals
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Today", value: earnings.today },
                { label: "This week", value: earnings.week },
                { label: "This month", value: earnings.month },
                { label: "Total", value: earnings.total },
              ].map((e) => (
                <div key={e.label} className="rounded-xl bg-muted/50 p-3 text-center">
                  <p className="font-display text-lg font-bold tabular-nums">${e.value}</p>
                  <p className="text-[11px] text-muted-foreground">{e.label}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Account settings tabs */}
      <Card>
        <CardContent className="pt-6">
          <Tabs defaultValue="account">
            <TabsList className="w-full">
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="security" disabled={!isEmailUser}>
                Security
              </TabsTrigger>
            </TabsList>

            <TabsContent value="account" className="pt-4">
              <Label htmlFor="phone" className="mb-1.5">
                Phone number
              </Label>
              <div className="flex gap-2">
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Add mobile"
                  inputMode="tel"
                />
                <Button onClick={savePhone}>Save</Button>
              </div>
            </TabsContent>

            <TabsContent value="security" className="space-y-6 pt-4">
              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="size-4 text-muted-foreground" /> Change password
                </h3>
                <Input
                  type="password"
                  placeholder="Current password"
                  value={curPass}
                  onChange={(e) => setCurPass(e.target.value)}
                  autoComplete="current-password"
                />
                <Input
                  type="password"
                  placeholder="New password (min 6 characters)"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  autoComplete="new-password"
                />
                <Button
                  className="w-full"
                  onClick={changePassword}
                  disabled={passBusy || !curPass || !newPass}
                >
                  {passBusy ? "Saving…" : "Update password"}
                </Button>
              </div>

              <Separator />

              <div className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Mail className="size-4 text-muted-foreground" /> Change email
                </h3>
                <Input
                  type="email"
                  placeholder="New email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  autoComplete="email"
                />
                <Input
                  type="password"
                  placeholder="Current password"
                  value={mailPass}
                  onChange={(e) => setMailPass(e.target.value)}
                  autoComplete="current-password"
                />
                <Button
                  className="w-full"
                  onClick={changeEmail}
                  disabled={mailBusy || !newEmail || !mailPass}
                >
                  {mailBusy ? "Sending…" : "Send confirmation link"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  A confirmation link goes to the new address — your login email changes after you
                  tap it.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Footer actions */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" className="flex-1" onClick={installApp}>
          <Smartphone className="size-4" /> Download app
        </Button>
        <Button
          variant="outline"
          className="flex-1 text-destructive hover:bg-destructive/10"
          onClick={logout}
        >
          <LogOut className="size-4" /> Log out
        </Button>
      </div>
    </div>
  );
}

function ReferralLink({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <button
        onClick={onCopy}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl border border-border bg-muted/50 p-2.5 text-left transition-colors hover:border-primary/40",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs">{value}</span>
        <Copy className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}
