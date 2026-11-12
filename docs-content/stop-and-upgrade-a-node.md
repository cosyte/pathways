---
id: stop-and-upgrade-a-node
title: Stop and upgrade a node
sidebar_label: Stop and upgrade a node
description: "Stop a Pathways node behind a load balancer without losing or cutting off a message: it turns not ready, waits for the balancer, finishes the work in flight within a bound, releases its lease, and exits 0. Recipes for an AWS Network Load Balancer, Kubernetes and Azure Container Apps."
---

# Stop and upgrade a node

A node is one running `pathways start`. To upgrade it, or move it, or let it go in a scale-in, you
stop it, and the stop is a drain: nothing it took in is lost, a message it was answering gets its
ACK, and a sender is moved to another node rather than cut off in the middle of a message.

## What a stop does

On the first SIGTERM or SIGINT, `pathways start`:

1. reports draining: `/readyz` answers 503 `draining`, and the health body says `"draining": true`;
2. keeps taking messages in for `drain.notReadyDelay` (0 by default), so a load balancer that reads
   `/readyz`, or an orchestrator that is removing the node from its endpoints, stops sending it new
   connections first;
3. closes its listeners and stops polling: a new connection is refused, and an idle MLLP connection
   is closed at once;
4. lets each MLLP connection finish the message it is handling, stored and answered, and then closes
   it; a message that arrives after that is neither stored nor answered, so its sender sends it
   again;
5. lets the transforms and sends under way finish, and makes a last pass over what was taken in,
   all within `drain.timeout` (30 seconds by default);
6. releases its engine lease, so another engine can take it at once, and exits 0.

```yaml title="pathways.yaml"
encryption:
  keys: [{ id: main, file: ./keys/main.key }]
  current: main
probes: { port: 9091, host: 0.0.0.0, plaintext: true }
drain:
  notReadyDelay: 10s
  timeout: 30s
```

What `drain.timeout` cuts off is never lost. A message not yet stored got no ACK, so its sender
sends it again. A send under way stays pending, and the next start sends it again, flagged as a
possible duplicate (see [delivery and errors](./delivery-and-errors.md)), since the receiver may
have it. A transform under way at the timeout finishes first, within its own `timeout`.

A second SIGTERM or SIGINT stops the engine at once, as a hard stop does. A hard stop loses no
message either, for the same reasons; its lease is left to lapse, so the next engine waits for
that.

Whoever stops the node must wait longer than `drain.notReadyDelay` plus `drain.timeout`, plus a few
seconds for the hooks, before it sends SIGKILL. Each recipe below says where that wait is set.

## Move senders with maxConnectionAge

Many HL7 senders open one MLLP connection and keep it all day. Behind a load balancer, a connection
stays on the node it first reached, so a node added later, or one restarted, gets no traffic until
the senders reconnect. `maxConnectionAge` on an MLLP source closes a connection once it is older
than the age, after the message it brings and that message's ACK, and the sender connects again
through the balancer:

```yaml title="channels/adt-in/channel.yaml"
format: hl7v2
source:
  mllp:
    port: 2575
    host: 0.0.0.0
    tls: { cert: ../../certs/server.pem, key: ../../certs/server.key }
    maxConnectionAge: 1h
transform: ./transform.ts
destinations:
  - file: { dir: ../../data/adt-in/out }
```

It is off by default. How a sender takes a closed connection is up to the sender: most connect
again and go on, but test yours against it before you turn it on.

## AWS Network Load Balancer

Put the node's MLLP port behind a target group with a TCP listener, and point the target group's
health check at the probe listener: protocol HTTP, the probe port, path `/readyz`. The probe
listener must listen where the balancer can reach it (`host: 0.0.0.0`, as above).

Two target group attributes decide what happens to the connections of a target that is removing:

- `deregistration_delay.timeout_seconds`: how long the balancer waits, once a target is
  deregistering, before it is gone. It sends the target no new connections meanwhile.
- `deregistration_delay.connection_termination.enabled`: with `true`, the balancer closes the
  connections still open at the end of that delay, so a sender on a long-lived connection
  reconnects to another target. Without it, such a connection stays on the old target until it
  closes.

```bash
aws elbv2 modify-target-group-attributes \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --attributes \
    Key=deregistration_delay.timeout_seconds,Value=30 \
    Key=deregistration_delay.connection_termination.enabled,Value=true
```

On Amazon ECS, a service behind the target group deregisters a task before it stops it: the task
waits out the deregistration delay, then its container gets SIGTERM, and SIGKILL `stopTimeout`
seconds later. ECS caps `stopTimeout` at 120 seconds, so `drain.notReadyDelay` plus
`drain.timeout` must fit inside it. The deregistration delay has already moved the senders, so
`notReadyDelay` can stay 0 there.

On instances you stop yourself, deregister the target first (`aws elbv2 deregister-targets`), wait
out the delay, then stop the engine. Or rely on the health check: set `drain.notReadyDelay` longer
than the health check's interval times its unhealthy threshold, so the balancer has marked the node
unhealthy before its listener closes.

## Kubernetes

Point the readiness probe at `/readyz` and the liveness probe at `/livez`, on the probe port:

```yaml title="pathways-deployment.yaml" no-check a Kubernetes manifest, not a Pathways file
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: pathways
          image: registry.example.com/our-integrations:2026.11.12
          ports:
            - { name: mllp, containerPort: 2575 }
            - { name: probes, containerPort: 9091 }
          readinessProbe:
            httpGet: { path: /readyz, port: probes }
            periodSeconds: 5
            failureThreshold: 1
          livenessProbe:
            httpGet: { path: /livez, port: probes }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
```

When a pod is deleted, Kubernetes removes it from the Service's endpoints and starts its stop at the
same time, not one after the other, so for a few seconds traffic can still reach a pod that is
stopping. Cover that window before the listener closes, with a `preStop` hook that sleeps, or with
`drain.notReadyDelay`, or both. The image has no shell, so a `preStop` hook that runs `sleep` as a
command cannot work; the hook's own `sleep` action, shown above, needs Kubernetes 1.30 or later.
Without it, set `drain.notReadyDelay` instead.

`terminationGracePeriodSeconds` counts from the start of the stop, the `preStop` hook included, and
SIGKILL follows when it runs out. Set it above the `preStop` sleep plus `drain.notReadyDelay` plus
`drain.timeout`: above 5 + 10 + 30 seconds with the settings on this page, so 60.

## Azure Container Apps

Expose the MLLP port with TCP ingress, and give the container a readiness probe and a liveness
probe on the probe port, `/readyz` and `/livez`. When a replica is stopped, in a scale-in or when a
revision is replaced, its container gets SIGTERM, and SIGKILL once the grace period runs out: set
the template's `terminationGracePeriodSeconds` (30 seconds by default) above
`drain.notReadyDelay` plus `drain.timeout`.

```yaml title="containerapp.yaml" no-check an Azure Container Apps template, not a Pathways file
properties:
  configuration:
    ingress:
      transport: tcp
      targetPort: 2575
      exposedPort: 2575
  template:
    terminationGracePeriodSeconds: 60
    containers:
      - name: pathways
        image: registry.example.com/our-integrations:2026.11.12
        probes:
          - type: Readiness
            httpGet: { path: /readyz, port: 9091 }
            periodSeconds: 5
          - type: Liveness
            httpGet: { path: /livez, port: 9091 }
            periodSeconds: 10
```

## Upgrade a node

To upgrade, stop the node as above and start the new version. When the new version changes the
schema, apply its expand steps first and keep the way back open: see
[Upgrade Pathways](./upgrade-pathways.md). With a standby on another node, the standby takes the
engine lease at its next try after the draining node releases it: it tries every third of
`lease.ttl`, so within 5 seconds with the default 15 second lease.

## Related

- [Check status and health](./check-status-and-health.md#probe-liveness-and-readiness)
- [Run Pathways in Docker](./run-in-docker.md)
- [Configuration reference: Drain](./configuration-reference.md#drain)
- [Send and receive HL7 v2 over MLLP](./send-and-receive-mllp.md#bound-connections-and-messages)
