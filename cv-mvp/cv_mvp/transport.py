"""Bounded latest-pose mailbox; every event is retained until send or explicit failure."""

from copy import deepcopy
from threading import Lock


class Mailbox:
    def __init__(self, limit=128):
        self.limit = limit
        self.lock = Lock()
        self.latest = None
        self.events = []
        self.first = None
        self.failed = False

    def offer(self, sample):
        with self.lock:
            if self.failed:
                return False
            if len(self.events) + len(sample["events"]) > self.limit:
                self.failed = True
                self.latest = None
                self.events.clear()
                return True
            if self.first is None:
                self.first = sample["seq"]
            self.latest = sample
            self.events.extend(sample["events"])
            return True

    def pop(self):
        with self.lock:
            if self.failed:
                raise BufferError(
                    "Event overflow; coverage uncertain. Reconnect without replaying old punches."
                )
            if self.latest is None:
                return None
            sample = deepcopy(self.latest)
            sample["events"] = deepcopy(self.events)
            first = self.first
            self.latest = None
            self.events = []
            self.first = None
            return sample, first
