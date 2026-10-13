import { useState } from "react";
import { Trash2 } from "lucide-react";
import { ref, remove, set } from "@/lib/fb/database";
import { useStore } from "@/context/StoreContext";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TicketPercent } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export function CouponsAdmin({
  coupons,
  onDone,
}: {
  coupons: Array<{ code: string; type: string; value: number }>;
  onDone: () => void;
}) {
  const { db, notify } = useStore();
  const [form, setForm] = useState({ code: "", type: "flat", value: "", minOrder: "", maxUsage: "1" });

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      {/* Create */}
      <Card className="lg:sticky lg:top-20 lg:self-start">
        <CardHeader>
          <CardTitle className="text-base">Create coupon</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="code" className="mb-1.5">
              Code
            </Label>
            <Input
              id="code"
              className="uppercase"
              placeholder="CODE"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1.5">Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="flat">Flat $</SelectItem>
                  <SelectItem value="percent">Percent %</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="value" className="mb-1.5">
                Value
              </Label>
              <Input
                id="value"
                inputMode="decimal"
                placeholder="Value"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="minOrder" className="mb-1.5">
              Minimum order
            </Label>
            <Input
              id="minOrder"
              inputMode="decimal"
              placeholder="0"
              value={form.minOrder}
              onChange={(e) => setForm({ ...form, minOrder: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="maxUsage" className="mb-1.5">
              Usage limit per user
            </Label>
            <Input
              id="maxUsage"
              inputMode="numeric"
              placeholder="1"
              value={form.maxUsage}
              onChange={(e) => setForm({ ...form, maxUsage: e.target.value })}
            />
          </div>
          <Button
            className="w-full"
            onClick={async () => {
              if (!db || !form.code || !form.value) return notify("Code and value are required");
              await set(ref(db, `coupons/${form.code}`), {
                type: form.type,
                value: Number(form.value),
                minOrder: Number(form.minOrder || 0),
                maxUsage: Number(form.maxUsage || 1),
              });
              setForm({ code: "", type: "flat", value: "", minOrder: "", maxUsage: "1" });
              onDone();
            }}
          >
            Create coupon
          </Button>
        </CardContent>
      </Card>

      {/* List */}
      {coupons.length ? (
        <Card className="gap-0 overflow-hidden py-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coupons.map((c) => (
                  <TableRow key={c.code}>
                    <TableCell>
                      <Badge variant="muted" className="font-mono">
                        {c.code}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm font-medium tabular-nums">
                      {c.type === "percent" ? `${c.value}%` : `$${c.value}`}
                    </TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-destructive hover:bg-destructive/10"
                            aria-label={`Delete ${c.code}`}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete coupon {c.code}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This code will stop working immediately. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={async () => {
                                if (db) await remove(ref(db, `coupons/${c.code}`));
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState icon={TicketPercent} title="No coupons yet" description="Create your first discount code." />
      )}
    </div>
  );
}
