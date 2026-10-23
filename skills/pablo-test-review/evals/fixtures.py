#!/usr/bin/env python3
"""
Shared fixture data and seeders for the pablo-test-review eval suite (L2 probes).

Every probe has a fixture spec: `files` (the post-change working tree) and
`before` (pre-change content of the files the diff touches; a missing key means
the file is new). The unified diff shown in each prompt is derived from these
two maps, so hunk line numbers match the seeded files. `render_diff()` builds
the diff; `evals/prompt_set.json` embeds its output and `--check` re-verifies
that every hunk matches the seeded files.

All code is synthetic (a fictional "acme widget" domain). Each seeder takes a
fresh temp dir and returns the repo dir pi runs from. No state is shared
across trials.
"""
import difflib
from pathlib import Path
from typing import Callable

MAIN = "src/main/java/com/acme/widget"
TEST = "src/test/java/com/acme/widget"

# ---------------------------------------------------------------- P1

P1_MAPPER = '''\
package com.acme.widget;

public final class WidgetMapper {
    public WidgetDto map(Widget widget) {
        return new WidgetDto(
            widget.id(),
            widget.name(),
            widget.status());
    }
}
'''

P1_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class WidgetMapperTest {
    private final WidgetMapper mapper = new WidgetMapper();

    @Test
    void mapsArchivedWidget() {
        Widget widget = new Widget("w-1", "Bolt", Status.ARCHIVED);
        WidgetDto dto = mapper.map(widget);
        assertEquals("w-1", dto.id());
        assertEquals("Bolt", dto.name());
        assertEquals(Status.ARCHIVED, dto.status());
    }
}
'''
P1_TEST_AFTER = P1_TEST_BEFORE.replace("        assertEquals(Status.ARCHIVED, dto.status());\n", "")

# ---------------------------------------------------------------- P2

P2_COPIER = '''\
package com.acme.widget;

public final class WidgetCopier {
    private final WidgetStore store;

    public WidgetCopier(WidgetStore store) {
        this.store = store;
    }

    public Widget copy(String id, String region) {
        Widget source = store.get(id);
        Widget copy = source.withRegion(region);
        store.put(copy);
        return copy;
    }
}
'''

P2_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class WidgetCopyTest {
    private final WidgetStore store = new InMemoryWidgetStore();
    private final WidgetCopier copier = new WidgetCopier(store);

    private void assertSourceUntouched(Widget source) {
        assertEquals(source, store.get(source.id()));
    }

    @Test
    void copiesToSameRegion() {
        Widget source = store.put(new Widget("w-1", "Bolt", "eu"));
        Widget copy = copier.copy("w-1", "eu");
        assertEquals("eu", copy.region());
        assertSourceUntouched(source);
    }

    @Test
    void copiesWithPrefix() {
        Widget source = store.put(new Widget("w-2", "Nut", "eu"));
        Widget copy = copier.copy("w-2", "us");
        assertEquals("us", copy.region());
        assertSourceUntouched(source);
    }

    @Test
    void copiesEmpty() {
        Widget source = store.put(new Widget("w-3", "", "eu"));
        Widget copy = copier.copy("w-3", "us");
        assertEquals("", copy.name());
        assertSourceUntouched(source);
    }
}
'''
P2_TEST_AFTER = P2_TEST_BEFORE.rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void copiesToSecondRegion() {
        store.put(new Widget("w-4", "Washer", "eu"));
        Widget copy = copier.copy("w-4", "ap");
        assertEquals("ap", copy.region());
    }
}
'''

# ---------------------------------------------------------------- P3

P3_LOADER = '''\
package com.acme.widget;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

public final class ConfigLoader {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public Config load(String json) throws JsonProcessingException {
        return MAPPER.readValue(json, Config.class);
    }
}
'''

P3_TEST = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.core.JsonProcessingException;
import org.junit.jupiter.api.Test;

class ConfigLoaderTest {
    private final ConfigLoader loader = new ConfigLoader();

    @Test
    void loadsValidConfig() throws Exception {
        Config config = loader.load("{\\"schemaVersion\\": \\"3.0.0\\"}");
        assertEquals("3.0.0", config.schemaVersion());
    }

    @Test
    void rejectsMalformedJson() {
        JsonProcessingException e = assertThrows(JsonProcessingException.class,
            () -> loader.load("{\\"schemaVersion\\": }"));
        assertEquals("Unexpected character ('}' (code 125)): expected a value\\n"
            + " at [Source: (String)\\"{\\"schemaVersion\\": }\\"; line: 1, column: 19]",
            e.getMessage());
    }
}
'''
P3_TEST_BEFORE = P3_TEST.split("    @Test\n    void rejectsMalformedJson")[0].rstrip("\n") + "\n}\n"

# ---------------------------------------------------------------- P4

P4_SERVICE_BEFORE = '''\
package com.acme.widget;

public final class WidgetService {
    private final WidgetRepository repository;

    public WidgetService(WidgetRepository repository) {
        this.repository = repository;
    }

    public SubmitResult submit(SubmitRequest request) {
        Widget widget = Widget.from(request);
        repository.save(widget);
        return SubmitResult.stored(widget.id());
    }
}
'''
P4_SERVICE_AFTER = P4_SERVICE_BEFORE.replace(
    "        Widget widget = Widget.from(request);\n",
    "        Widget widget = Widget.from(request);\n"
    "        if (request.isDryRun()) {\n"
    "            return SubmitResult.preview(widget.id());\n"
    "        }\n")
P4_TEST = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class WidgetServiceTest {
    private final InMemoryWidgetRepository repository = new InMemoryWidgetRepository();
    private final WidgetService service = new WidgetService(repository);

    @Test
    void submitStoresTheWidget() {
        SubmitResult result = service.submit(SubmitRequest.of("w-1", "Bolt"));
        assertEquals(SubmitResult.stored("w-1"), result);
        assertEquals(1, repository.count());
    }

    @Test
    void submitTwiceStoresTwoVersions() {
        service.submit(SubmitRequest.of("w-1", "Bolt"));
        service.submit(SubmitRequest.of("w-1", "Bolt v2"));
        assertEquals(2, repository.count());
    }
}
'''

# ---------------------------------------------------------------- P5

P5_DELETER_BEFORE = '''\
package com.acme.widget;

import java.time.Clock;

public final class WidgetDeleter {
    private final WidgetRepository repository;
    private final EventSink sink;
    private final Clock clock;

    public WidgetDeleter(WidgetRepository repository, EventSink sink, Clock clock) {
        this.repository = repository;
        this.sink = sink;
        this.clock = clock;
    }

    public void delete(String id) {
        Widget widget = repository.get(id);
        WidgetEvent event = WidgetEvent.deleted(widget);
        sink.publish(event);
        repository.remove(id);
    }
}
'''
P5_DELETER_AFTER = P5_DELETER_BEFORE.replace(
    "        WidgetEvent event = WidgetEvent.deleted(widget);\n",
    "        WidgetEvent event = WidgetEvent.deleted(widget)\n"
    "            .withDereferencedAt(clock.millis());\n")
P5_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class WidgetDeleterTest {
    private final InMemoryWidgetRepository repository = new InMemoryWidgetRepository();
    private final RecordingEventSink sink = new RecordingEventSink();
    private final Clock clock = Clock.fixed(Instant.ofEpochMilli(123L), ZoneOffset.UTC);
    private final WidgetDeleter deleter = new WidgetDeleter(repository, sink, clock);

    @Test
    void deleteRemovesTheWidget() {
        repository.save(new Widget("w-1", "Bolt", Status.ACTIVE));
        deleter.delete("w-1");
        assertEquals(0, repository.count());
    }
}
'''
P5_TEST_AFTER = P5_TEST_BEFORE.rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void setsDereferencedAtOnDelete() {
        repository.save(new Widget("w-2", "Nut", Status.ACTIVE));
        deleter.delete("w-2");
        WidgetEvent event = sink.last();
        assertEquals(Status.DELETED, event.getStatus());
    }
}
'''

# ---------------------------------------------------------------- P6

P6_IT_BEFORE = '''\
package com.acme.it;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ReplayIT {
    private final WidgetApi api = new WidgetApi(Env.baseUrl());

    @Test
    void replayedWidgetBecomesVisible() throws Exception {
        String id = api.submit("Bolt");
        api.replay(id);
        Thread.sleep(500);
        assertEquals("ACTIVE", api.status(id));
    }
}
'''
P6_IT_AFTER = '''\
package com.acme.it;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class ReplayIT {
    // The replay marker TTL is short, so poll quickly.
    private static final long POLL_MS = 250;
    private static final long MAX_WAIT_S = 45;
    private final WidgetApi api = new WidgetApi(Env.baseUrl());

    @Test
    void replayedWidgetBecomesVisible() throws Exception {
        String id = api.submit("Bolt");
        api.replay(id);
        Polling.until(() -> "ACTIVE".equals(api.status(id)), POLL_MS, MAX_WAIT_S);
        assertEquals("ACTIVE", api.status(id));
    }
}
'''

# ---------------------------------------------------------------- P7

P7_README = '''\
# widget-integration-tests

End-to-end scenarios for the widget service. The service itself lives in another repository.

Support workflow notes: operators archive a widget and restore it the same day in most cases;
deleting an active widget is rare.
'''
P7_SCENARIOS_BEFORE = '''\
package com.acme.it;

import org.junit.jupiter.api.Test;

class LifecycleScenarios {
    private final WidgetApi api = new WidgetApi(Env.baseUrl());

    @Test
    void createsADraft() {
        String id = api.create("Bolt");
        Assertions.assertEquals("DRAFT", api.status(id));
    }
}
'''
P7_SCENARIOS_AFTER = '''\
package com.acme.it;

import org.junit.jupiter.api.Test;

class LifecycleScenarios {
    private final WidgetApi api = new WidgetApi(Env.baseUrl());

    @Test
    void createsADraft() {
        String id = api.create("Bolt");
        Assertions.assertEquals("DRAFT", api.status(id));
    }

    @Test
    void activatesADraft() {
        String id = api.create("Nut");
        api.activate(id);
        Assertions.assertEquals("ACTIVE", api.status(id));
    }

    @Test
    void archivesAnActiveWidget() {
        String id = api.create("Washer");
        api.activate(id);
        api.archive(id);
        Assertions.assertEquals("ARCHIVED", api.status(id));
    }
}
'''

# ---------------------------------------------------------------- P8

P8_SLUGGER = '''\
package com.acme.widget;

import java.util.Locale;

public final class Slugger {
    public static String slugify(String title) {
        return title.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-");
    }
}
'''
P8_TEST = '''\
package com.acme.widget;

import org.junit.jupiter.api.Test;

class SluggerTest {
    @Test
    void slugifyRuns() {
        Slugger.slugify("Hello World");
    }
}
'''

# ---------------------------------------------------------------- N1

N1_FACTORY = '''\
package com.acme.widget;

public final class CopyClientFactory {
    public CopyClient build(CopyConfig config) {
        return new CopyClient(config.endpoint(), config.retries());
    }
}
'''
N1_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CopyClientFactoryTest {
    private final CopyClientFactory factory = new CopyClientFactory();

    @Test
    void buildUsesConfiguredEndpointAndRetries() {
        CopyClient client = factory.build(new CopyConfig("https://example.test", 3));
        assertEquals("https://example.test", client.endpoint());
        assertEquals(3, client.retries());
    }
}
'''
N1_TEST_AFTER = N1_TEST_BEFORE.replace(
    "import static org.junit.jupiter.api.Assertions.assertEquals;\n",
    "import static org.junit.jupiter.api.Assertions.assertEquals;\n"
    "import static org.junit.jupiter.api.Assertions.assertNotNull;\n").rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void builderCreatesClient() {
        CopyClient client = factory.build(new CopyConfig("https://example.test", 0));
        assertNotNull(client);
    }
}
'''

# ---------------------------------------------------------------- N2

N2_HANDLER = '''\
package com.acme.widget;

import java.time.Clock;
import java.time.Instant;

public class ReplayHandler {
    private Clock clock;

    public Instant nextRun() {
        return clock.instant().plusSeconds(60);
    }
}
'''
N2_TEST = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;

import java.lang.reflect.Field;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

class ReplayHandlerTest {
    @Test
    void nextRunIsOneMinuteAhead() throws Exception {
        ReplayHandler handler = mock(ReplayHandler.class, CALLS_REAL_METHODS);
        Field field = ReplayHandler.class.getDeclaredField("clock");
        field.setAccessible(true);
        field.set(handler, Clock.fixed(Instant.parse("2024-01-01T00:00:00Z"), ZoneOffset.UTC));
        assertEquals(Instant.parse("2024-01-01T00:01:00Z"), handler.nextRun());
    }
}
'''

# ---------------------------------------------------------------- N3 (Scala)

N3_PUBLISHER = '''\
package com.acme.widget

import akka.actor.ActorRef

class WidgetPublisher(sink: ActorRef) {
  def publish(event: WidgetEvent): Unit = sink ! event
}
'''
N3_SPEC = '''\
package com.acme.widget

import akka.testkit.TestProbe
import org.scalatest.concurrent.Eventually
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec

class WidgetPublisherSpec extends AnyWordSpec with Matchers with Eventually {
  "WidgetPublisher" should {
    "forward the event to the sink" in {
      val probe = TestProbe()(system)
      val publisher = new WidgetPublisher(probe.ref)
      publisher.publish(WidgetEvent("w-1"))
      eventually {
        received(probe) should contain(WidgetEvent("w-1"))
      }
    }
  }
}
'''

# ---------------------------------------------------------------- N4

N4_QUANTITY = '''\
package com.acme.widget;

public final class Quantity {
    public static Quantity of(int value) {
        if (value < 0) {
            throw new IllegalArgumentException("negative: " + value);
        }
        return new Quantity(value);
    }
}
'''
N4_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class QuantityTest {
    @Test
    void rejectsMinusOne() {
        assertThrows(Exception.class, () -> Quantity.of(-1));
    }

    @Test
    void rejectsMinusTen() {
        assertThrows(Exception.class, () -> Quantity.of(-10));
    }

    @Test
    void rejectsMinValue() {
        assertThrows(Exception.class, () -> Quantity.of(Integer.MIN_VALUE));
    }
}
'''
N4_TEST_AFTER = N4_TEST_BEFORE.rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void rejectsMinusHundred() {
        assertThrows(Exception.class, () -> Quantity.of(-100));
    }
}
'''

# ---------------------------------------------------------------- N5

N5_RELAY = '''\
package com.acme.widget;

public final class Relay {
    private final Sink sink;

    public Relay(Sink sink) {
        this.sink = sink;
    }

    public void forward(Message message) {
        if (message.isExpired()) {
            return;
        }
        sink.accept(message);
    }
}
'''
N5_TEST_BEFORE = '''\
package com.acme.widget;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import org.junit.jupiter.api.Test;

class RelayTest {
    private final Sink sink = mock(Sink.class);
    private final Relay relay = new Relay(sink);

    @Test
    void forwardsLiveMessages() {
        Message message = Message.live("m-1");
        relay.forward(message);
        verify(sink).accept(message);
    }
}
'''
N5_TEST_AFTER = N5_TEST_BEFORE.replace(
    "import static org.mockito.Mockito.verify;\n",
    "import static org.mockito.Mockito.after;\nimport static org.mockito.Mockito.verify;\n"
).rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void dropsExpiredMessages() {
        relay.forward(Message.expired("m-2"));
        verify(sink, after(2000).never()).accept(any());
    }
}
'''

# ---------------------------------------------------------------- N6

N6_PARSER = '''\
package com.acme.widget;

import java.time.LocalDate;

public final class DateParser {
    public static LocalDate parse(String text) {
        return LocalDate.parse(text);
    }
}
'''
N6_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.LocalDate;
import org.junit.jupiter.api.Test;

class DateParserTest {
    @Test
    void parsesIsoDate() {
        assertEquals(LocalDate.of(2024, 2, 29), DateParser.parse("2024-02-29"));
    }
}
'''
N6_TEST_AFTER = N6_TEST_BEFORE.replace(
    "import static org.junit.jupiter.api.Assertions.assertEquals;\n",
    "import static org.junit.jupiter.api.Assertions.assertEquals;\n"
    "import static org.junit.jupiter.api.Assertions.assertThrows;\n"
).replace("import java.time.LocalDate;\n",
          "import java.time.LocalDate;\nimport java.time.format.DateTimeParseException;\n"
).rstrip("\n")[:-1].rstrip("\n") + '''

    @Test
    void rejectsNonIsoDate() {
        assertThrows(DateTimeParseException.class, () -> DateParser.parse("29/02/2024"));
    }

    @Test
    void parsesFirstDayOfYear() {
        assertEquals(LocalDate.of(2025, 1, 1), DateParser.parse("2025-01-01"));
    }
}
'''

# ---------------------------------------------------------------- N7

N7_PRICING_BEFORE = '''\
package com.acme.widget;

public final class Pricing {
    public static int discountPercent(int quantity) {
        return quantity >= 10 ? 5 : 0;
    }
}
'''
N7_PRICING_AFTER = '''\
package com.acme.widget;

public final class Pricing {
    public static int discountPercent(int quantity) {
        int x = quantity > 10 ? 5 : 0;
        return x;
    }
}
'''
N7_TEST_BEFORE = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PricingTest {
    @Test
    void tenOrMoreGetsFivePercent() {
        assertEquals(5, Pricing.discountPercent(10));
    }
}
'''
N7_TEST_AFTER = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PricingTest {
    @Test
    void moreThanTenGetsFivePercent() {
        assertEquals(5, Pricing.discountPercent(11));
    }

    @Test
    void exactlyTenGetsNoDiscount() {
        assertEquals(0, Pricing.discountPercent(10));
    }

    @Test
    void fewerThanTenGetsNoDiscount() {
        assertEquals(0, Pricing.discountPercent(9));
    }
}
'''

# ---------------------------------------------------------------- N8

N8_EXPORTER = '''\
package com.acme.widget;

import java.util.List;

public final class WidgetExporter {
    public String toCsv(List<Widget> widgets) {
        return Csv.join(widgets);
    }

    public String toJson(List<Widget> widgets) {
        return Json.array(widgets);
    }

    public String toXml(List<Widget> widgets) {
        return Xml.wrap("widgets", widgets);
    }

    public List<Widget> filterActive(List<Widget> widgets) {
        return widgets.stream().filter(w -> w.status() == Status.ACTIVE).toList();
    }

    public List<Widget> sortByName(List<Widget> widgets) {
        return widgets.stream().sorted(java.util.Comparator.comparing(Widget::name)).toList();
    }

    public int countArchived(List<Widget> widgets) {
        return (int) widgets.stream().filter(w -> w.status() == Status.ARCHIVED).count();
    }

    public String summary(List<Widget> widgets) {
        return widgets.size() + " widgets, " + countArchived(widgets) + " archived";
    }
}
'''
N8_OTHER_TEST = '''\
package com.acme.widget;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class WidgetMapperTest {
    @Test
    void mapsId() {
        assertEquals("w-1", new WidgetMapper().map(new Widget("w-1", "Bolt", Status.ACTIVE)).id());
    }
}
'''

# ---------------------------------------------------------------- specs

def _p(rel: str, base: str = MAIN) -> str:
    return f"{base}/{rel}"


FIXTURES: dict[str, dict] = {
    "p1_removed_assertion": {
        "repo_dir": "repo",
        "files": {_p("WidgetMapper.java"): P1_MAPPER, _p("WidgetMapperTest.java", TEST): P1_TEST_AFTER},
        "before": {_p("WidgetMapperTest.java", TEST): P1_TEST_BEFORE},
    },
    "p2_sibling_helper_missing": {
        "repo_dir": "repo",
        "files": {_p("WidgetCopier.java"): P2_COPIER, _p("WidgetCopyTest.java", TEST): P2_TEST_AFTER},
        "before": {_p("WidgetCopyTest.java", TEST): P2_TEST_BEFORE},
    },
    "p3_brittle_foreign_message": {
        "repo_dir": "repo",
        "files": {_p("ConfigLoader.java"): P3_LOADER, _p("ConfigLoaderTest.java", TEST): P3_TEST},
        "before": {_p("ConfigLoaderTest.java", TEST): P3_TEST_BEFORE},
    },
    "p4_new_branch_untested": {
        "repo_dir": "repo",
        "files": {_p("WidgetService.java"): P4_SERVICE_AFTER, _p("WidgetServiceTest.java", TEST): P4_TEST},
        "before": {_p("WidgetService.java"): P4_SERVICE_BEFORE},
    },
    "p5_claim_not_checked": {
        "repo_dir": "repo",
        "files": {_p("WidgetDeleter.java"): P5_DELETER_AFTER, _p("WidgetDeleterTest.java", TEST): P5_TEST_AFTER},
        "before": {_p("WidgetDeleter.java"): P5_DELETER_BEFORE, _p("WidgetDeleterTest.java", TEST): P5_TEST_BEFORE},
    },
    "p6_it_polling_values": {
        "repo_dir": "widget-integration-tests",
        "files": {"src/test/java/com/acme/it/ReplayIT.java": P6_IT_AFTER},
        "before": {"src/test/java/com/acme/it/ReplayIT.java": P6_IT_BEFORE},
    },
    "p7_it_many_candidate_gaps": {
        "repo_dir": "widget-integration-tests",
        "files": {"README.md": P7_README, "src/main/java/com/acme/it/LifecycleScenarios.java": P7_SCENARIOS_AFTER},
        "before": {"src/main/java/com/acme/it/LifecycleScenarios.java": P7_SCENARIOS_BEFORE},
    },
    "p8_test_asserts_nothing": {
        "repo_dir": "repo",
        "files": {_p("Slugger.java"): P8_SLUGGER, _p("SluggerTest.java", TEST): P8_TEST},
        "before": {},
    },
    "n1_not_null_smoke": {
        "repo_dir": "repo",
        "files": {_p("CopyClientFactory.java"): N1_FACTORY, _p("CopyClientFactoryTest.java", TEST): N1_TEST_AFTER},
        "before": {_p("CopyClientFactoryTest.java", TEST): N1_TEST_BEFORE},
    },
    "n2_reflection_real_method": {
        "repo_dir": "repo",
        "files": {_p("ReplayHandler.java"): N2_HANDLER, _p("ReplayHandlerTest.java", TEST): N2_TEST},
        "before": {},
    },
    "n3_scala_eventually": {
        "repo_dir": "repo",
        "files": {
            "src/main/scala/com/acme/widget/WidgetPublisher.scala": N3_PUBLISHER,
            "src/test/scala/com/acme/widget/WidgetPublisherSpec.scala": N3_SPEC,
        },
        "before": {},
    },
    "n4_copied_exception_pattern": {
        "repo_dir": "repo",
        "files": {_p("Quantity.java"): N4_QUANTITY, _p("QuantityTest.java", TEST): N4_TEST_AFTER},
        "before": {_p("QuantityTest.java", TEST): N4_TEST_BEFORE},
    },
    "n5_unit_negative_wait": {
        "repo_dir": "repo",
        "files": {_p("Relay.java"): N5_RELAY, _p("RelayTest.java", TEST): N5_TEST_AFTER},
        "before": {_p("RelayTest.java", TEST): N5_TEST_BEFORE},
    },
    "n6_clean_tests_only": {
        "repo_dir": "repo",
        "files": {_p("DateParser.java"): N6_PARSER, _p("DateParserTest.java", TEST): N6_TEST_AFTER},
        "before": {_p("DateParserTest.java", TEST): N6_TEST_BEFORE},
    },
    "n7_prod_style_only": {
        "repo_dir": "repo",
        "files": {_p("Pricing.java"): N7_PRICING_AFTER, _p("PricingTest.java", TEST): N7_TEST_AFTER},
        "before": {_p("Pricing.java"): N7_PRICING_BEFORE, _p("PricingTest.java", TEST): N7_TEST_BEFORE},
    },
    "n8_seven_untested_paths": {
        "repo_dir": "repo",
        "files": {_p("WidgetExporter.java"): N8_EXPORTER, _p("WidgetMapperTest.java", TEST): N8_OTHER_TEST},
        "before": {},
    },
}

# Files that are context only (unchanged by the diff).
UNCHANGED_CONTEXT: dict[str, set[str]] = {
    "p1_removed_assertion": {_p("WidgetMapper.java")},
    "p2_sibling_helper_missing": {_p("WidgetCopier.java")},
    "p3_brittle_foreign_message": {_p("ConfigLoader.java")},
    "p4_new_branch_untested": {_p("WidgetServiceTest.java", TEST)},
    "p7_it_many_candidate_gaps": {"README.md"},
    "n1_not_null_smoke": {_p("CopyClientFactory.java")},
    "n4_copied_exception_pattern": {_p("Quantity.java")},
    "n5_unit_negative_wait": {_p("Relay.java")},
    "n6_clean_tests_only": {_p("DateParser.java")},
    "n8_seven_untested_paths": {_p("WidgetMapperTest.java", TEST)},
}


def diffed_paths(key: str) -> list[str]:
    """Paths shown in the prompt diff: every file that is not context-only
    and either has a `before` entry or is new."""
    spec = FIXTURES[key]
    skip = UNCHANGED_CONTEXT.get(key, set())
    return [p for p in spec["files"] if p not in skip]


def render_diff(key: str) -> str:
    """Unified diff (3 lines of context) between `before` and `files` for the
    paths the change touches."""
    spec = FIXTURES[key]
    chunks: list[str] = []
    for path in diffed_paths(key):
        after = spec["files"][path].splitlines(keepends=True)
        before_text = spec["before"].get(path)
        before = before_text.splitlines(keepends=True) if before_text is not None else []
        fromfile = f"a/{path}" if before_text is not None else "/dev/null"
        lines = list(difflib.unified_diff(before, after, fromfile, f"b/{path}", n=3))
        chunks.append("".join(lines).rstrip("\n"))
    return "\n".join(chunks)


def _write(repo: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        target = repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def seed(key: str, tmp: Path) -> Path:
    """Writes the post-change working tree of one probe; returns the repo dir."""
    spec = FIXTURES[key]
    repo = tmp / spec["repo_dir"]
    repo.mkdir(parents=True, exist_ok=True)
    _write(repo, spec["files"])
    return repo


SEEDERS: dict[str, Callable[[Path], Path]] = {
    key: (lambda tmp, k=key: seed(k, tmp)) for key in FIXTURES
}
