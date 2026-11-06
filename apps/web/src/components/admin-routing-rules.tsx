"use client";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { RuleSchema, type Rule } from "../lib/schemas";
import { toast } from "sonner";

export function AdminRoutingRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [newRule, setNewRule] = useState<{ position: number; condition: string; action: string; enabled: boolean }>({ position: 1, condition: "", action: "", enabled: true });
  const qc = useQueryClient();

  useEffect(() => {
    fetchRules();
  }, []);

  const fetchRules = async () => {
    const data = await api.routingRules.list();
    setRules(data as Rule[]);
  };

  const handleCreate = async () => {
    try {
      await api.routingRules.create({
        position: newRule.position,
        condition: newRule.condition,
        action: newRule.action,
        enabled: newRule.enabled,
      });
      await fetchRules();
      setNewRule({ position: 1, condition: "", action: "", enabled: true });
      toast.success("Rule added");
    } catch (err) {
      toast.error("Failed to add rule");
    }
  };

  return null;
}